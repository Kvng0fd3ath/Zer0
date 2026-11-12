'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chatCompletion, LLMError } = require('../src/core/llm');
const { transcribeAudio, synthesizeSpeech, VoiceError } = require('../src/core/voice');

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer };
}

test('chatCompletion posts to /chat/completions with bearer auth and tools', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'hello' } }] });
  };
  const msg = await chatCompletion({
    baseUrl: 'https://example.test/v1/',
    apiKey: 'sk-1',
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'get_time' } }],
    fetchImpl,
  });
  assert.equal(msg.content, 'hello');
  assert.equal(seen.url, 'https://example.test/v1/chat/completions');
  assert.equal(seen.init.headers.authorization, 'Bearer sk-1');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.tools.length, 1);
});

test('chatCompletion surfaces provider errors without leaking the key', async () => {
  const fetchImpl = async () => jsonResponse({ error: { message: 'Rate limited' } }, 429);
  await assert.rejects(
    chatCompletion({ baseUrl: 'https://x', apiKey: 'sk-secret', model: 'm', messages: [], fetchImpl }),
    (err) => err instanceof LLMError && err.message === 'Rate limited' && err.status === 429 && !err.message.includes('sk-secret'),
  );
});

test('chatCompletion requires a key', async () => {
  await assert.rejects(chatCompletion({ baseUrl: 'https://x', apiKey: '', model: 'm', messages: [] }), /No OpenAI API key/);
});

test('transcribeAudio sends multipart audio and returns trimmed text', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return jsonResponse({ text: '  remind me at five  ' });
  };
  const text = await transcribeAudio({ baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'stt', audio: Buffer.from([1, 2, 3]), mimeType: 'audio/webm', fetchImpl });
  assert.equal(text, 'remind me at five');
  assert.equal(seen.url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.ok(seen.init.body instanceof FormData);
  assert.equal(seen.init.body.get('model'), 'stt');
});

test('transcribeAudio rejects empty audio', async () => {
  await assert.rejects(transcribeAudio({ apiKey: 'k', model: 'x', audio: Buffer.alloc(0) }), VoiceError);
});

test('synthesizeSpeech returns a Buffer and truncates long input', async () => {
  let body;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer };
  };
  const out = await synthesizeSpeech({ apiKey: 'k', model: 'tts', voice: 'alloy', text: 'a'.repeat(5000), fetchImpl });
  assert.ok(Buffer.isBuffer(out));
  assert.equal(out.length, 3);
  assert.equal(body.response_format, 'mp3');
  assert.equal(body.input.length, 4000);
});

test('transcribeAudio passes the optional prompt to Whisper', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = init; return jsonResponse({ text: 'hey zero' }); };
  await transcribeAudio({ apiKey: 'k', model: 'stt', audio: Buffer.from([1]), prompt: 'Hey Zero', fetchImpl });
  assert.equal(seen.body.get('prompt'), 'Hey Zero');
});
