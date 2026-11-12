'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { transcribeWithNvidia, synthesizeWithFish, VoiceError, NVIDIA_STT_URL, FISH_TTS_URL } = require('../src/core/voice');
const { ConfigStore, voiceEngines } = require('../src/core/config');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zer0-voice-'));
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const bin = (bytes) => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(bytes).buffer });

test('NVIDIA speech posts the WAV to the NVIDIA endpoint with the nvapi key', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return json({ text: '  remind me at five  ' }); };
  const text = await transcribeWithNvidia({ apiKey: 'nvapi-test', wav: Buffer.from([1, 2, 3]), fetchImpl });
  assert.equal(text, 'remind me at five');
  assert.equal(seen.url, NVIDIA_STT_URL);
  assert.equal(seen.init.headers.authorization, 'Bearer nvapi-test');
  assert.equal(seen.init.body.get('language'), 'en-US');
  const file = seen.init.body.get('file');
  assert.equal(file.type, 'audio/wav');
});

test('NVIDIA speech reads a Riva-style response too', async () => {
  const fetchImpl = async () => json({ results: [{ alternatives: [{ transcript: 'hey zero what time is it' }] }] });
  assert.equal(await transcribeWithNvidia({ apiKey: 'nvapi-x', wav: Buffer.from([1]), fetchImpl }), 'hey zero what time is it');
});

test('NVIDIA speech needs a key and audio, and reports errors without the key', async () => {
  await assert.rejects(transcribeWithNvidia({ apiKey: '', wav: Buffer.from([1]) }), VoiceError);
  await assert.rejects(transcribeWithNvidia({ apiKey: 'nvapi-x', wav: Buffer.alloc(0) }), /No audio/);
  const fetchImpl = async () => json({ error: { message: 'Unauthorized' } }, 401);
  await assert.rejects(
    transcribeWithNvidia({ apiKey: 'nvapi-secret', wav: Buffer.from([1]), fetchImpl }),
    (err) => err instanceof VoiceError && err.status === 401 && !err.message.includes('nvapi-secret'),
  );
});

test('NVIDIA speech refuses a non-https address', async () => {
  await assert.rejects(transcribeWithNvidia({ url: 'http://example.test/x', apiKey: 'nvapi-x', wav: Buffer.from([1]), fetchImpl: async () => json({}) }), /https/);
});

test('Fish Audio speech posts JSON with the free model and returns MP3 bytes', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return bin([7, 8, 9]); };
  const out = await synthesizeWithFish({ apiKey: 'fish-key', text: 'Hello there', fetchImpl });
  assert.ok(Buffer.isBuffer(out));
  assert.equal(out.length, 3);
  assert.equal(seen.url, FISH_TTS_URL);
  assert.equal(seen.init.headers.authorization, 'Bearer fish-key');
  assert.equal(seen.init.headers.model, 's2.1-pro-free');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.text, 'Hello there');
  assert.equal(body.format, 'mp3');
  assert.equal('reference_id' in body, false, 'no voice ID sent when none is set');
});

test('Fish Audio speech sends a voice ID when one is set and truncates long text', async () => {
  let body;
  const fetchImpl = async (_url, init) => { body = JSON.parse(init.body); return bin([1]); };
  await synthesizeWithFish({ apiKey: 'fish-key', voiceId: 'voice-123', text: 'a'.repeat(5000), fetchImpl });
  assert.equal(body.reference_id, 'voice-123');
  assert.equal(body.text.length, 4000);
});

test('Fish Audio speech needs a key and reports its own error message', async () => {
  await assert.rejects(synthesizeWithFish({ apiKey: '', text: 'hi' }), /Fish Audio needs an API key/);
  const fetchImpl = async () => json({ status: 402, message: 'Payment required' }, 402);
  await assert.rejects(synthesizeWithFish({ apiKey: 'fish-key', text: 'hi', fetchImpl }), (err) => err.message === 'Payment required' && err.status === 402);
});

test('voiceEngines: an NVIDIA key only ever selects NVIDIA speech-to-text and never OpenAI', () => {
  assert.deepEqual(voiceEngines({ llmKey: 'nvapi-a', openaiKey: '', fishKey: '', fishVoiceId: '' }), {
    stt: { engine: 'nvidia', apiKey: 'nvapi-a' },
    tts: { engine: 'windows', apiKey: '' },
  });
  // An NVIDIA key in the OpenAI slot must not be sent to OpenAI.
  assert.deepEqual(voiceEngines({ llmKey: 'nvapi-a', openaiKey: 'nvapi-b', fishKey: '', fishVoiceId: '' }).tts, { engine: 'windows', apiKey: '' });
});

test('voiceEngines: OpenAI is used when there is no NVIDIA key, and Fish wins for speech output', () => {
  assert.deepEqual(voiceEngines({ llmKey: '', openaiKey: 'sk-1', fishKey: '', fishVoiceId: '' }), {
    stt: { engine: 'openai', apiKey: 'sk-1' },
    tts: { engine: 'openai', apiKey: 'sk-1' },
  });
  const both = voiceEngines({ llmKey: 'nvapi-a', openaiKey: 'sk-1', fishKey: 'fish-1', fishVoiceId: 'v1' });
  assert.equal(both.stt.engine, 'nvidia');
  assert.deepEqual(both.tts, { engine: 'fish', apiKey: 'fish-1', voiceId: 'v1' });
});

test('voiceEngines: no keys means no speech-to-text and the Windows voice', () => {
  assert.deepEqual(voiceEngines({ llmKey: '', openaiKey: '', fishKey: '', fishVoiceId: '' }), {
    stt: { engine: 'none', apiKey: '' },
    tts: { engine: 'windows', apiKey: '' },
  });
});

test('ConfigStore: Fish key is stored as a secret and reported as an engine name only', () => {
  const store = new ConfigStore({ dir: tmpDir(), env: {} });
  store.setSecret('llmApiKey', 'nvapi-chat');
  store.setSecret('fishApiKey', 'fish-secret');
  const view = store.publicView();
  assert.equal(view.secretsSet.fishApiKey, true);
  assert.deepEqual(view.voiceEngines, { stt: 'nvidia', tts: 'fish' });
  assert.equal(JSON.stringify(view).includes('fish-secret'), false, 'the Fish key never appears in the renderer view');
  assert.equal(JSON.stringify(view).includes('nvapi-chat'), false, 'the NVIDIA key never appears in the renderer view');
});

test('ConfigStore: Fish voice ID is trimmed and optional', () => {
  const store = new ConfigStore({ dir: tmpDir(), env: {} });
  store.setSecret('fishApiKey', 'fish-1');
  assert.equal(store.runtime().voice.tts.voiceId, '', 'blank by default');
  store.updateSettings({ voice: { fishVoiceId: '  abc  ' } });
  assert.equal(store.runtime().voice.tts.voiceId, 'abc');
});
