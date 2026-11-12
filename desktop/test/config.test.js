'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConfigStore, mergeKnown, sanitizeContacts, DEFAULT_SETTINGS } = require('../src/core/config');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zer0-cfg-'));
}

test('defaults are used when no settings file exists', () => {
  const store = new ConfigStore({ dir: tmpDir(), env: {} });
  assert.equal(store.settings.assistantName, 'Zer0');
  assert.equal(store.settings.llm.model, DEFAULT_SETTINGS.llm.model);
});

test('updateSettings persists and ignores unknown keys', () => {
  const dir = tmpDir();
  const store = new ConfigStore({ dir, env: {} });
  store.updateSettings({ assistantName: 'Friday', bogus: 1, llm: { model: 'x-model', nope: true } });
  const reloaded = new ConfigStore({ dir, env: {} });
  assert.equal(reloaded.settings.assistantName, 'Friday');
  assert.equal(reloaded.settings.llm.model, 'x-model');
  assert.equal(reloaded.settings.bogus, undefined);
  assert.equal(reloaded.settings.llm.nope, undefined);
});

test('type mismatches in a patch are rejected', () => {
  const merged = mergeKnown({ a: 'x', b: true }, { a: 5, b: 'nope' });
  assert.deepEqual(merged, { a: 'x', b: true });
});

test('contacts are sanitised', () => {
  const out = sanitizeContacts([
    { name: ' Mom ', phone: '+15551234567' },
    { name: '', phone: '+15550000000' },
    { name: 'NoPhone' },
    'garbage',
  ]);
  assert.deepEqual(out, [{ name: 'Mom', phone: '+15551234567' }]);
});

test('secrets round-trip through the codec and never appear in publicView', () => {
  const dir = tmpDir();
  const codec = { encrypt: (s) => `enc:${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(s.slice(4), 'base64').toString() };
  const store = new ConfigStore({ dir, codec, env: {} });
  store.setSecret('openaiApiKey', '  sk-test-123  ');
  const raw = fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8');
  assert.ok(!raw.includes('sk-test-123'), 'secret must not be stored in plaintext by the codec');
  assert.equal(store.getSecret('openaiApiKey'), 'sk-test-123');
  const view = store.publicView();
  assert.equal(view.secretsSet.openaiApiKey, true);
  assert.ok(!JSON.stringify(view).includes('sk-test-123'));
});

test('environment variables are used as a fallback for secrets', () => {
  const store = new ConfigStore({ dir: tmpDir(), env: { OPENAI_API_KEY: 'sk-env', TWILIO_FROM_NUMBER: '+15550001111' } });
  assert.equal(store.getSecret('openaiApiKey'), 'sk-env');
  assert.equal(store.runtime().twilio.fromNumber, '+15550001111');
});

test('unknown secret names are rejected', () => {
  const store = new ConfigStore({ dir: tmpDir(), env: {} });
  assert.throws(() => store.setSecret('evil', 'x'), /Unknown secret/);
});

test('empty value deletes a secret', () => {
  const store = new ConfigStore({ dir: tmpDir(), env: {} });
  store.setSecret('twilioAuthToken', 'tok');
  store.setSecret('twilioAuthToken', '');
  assert.equal(store.getSecret('twilioAuthToken'), '');
});

test('wake word defaults are off, "Hey Zero", normal sensitivity', () => {
  const store = new ConfigStore({ dir: tmpDir(), env: {} });
  assert.deepEqual(store.settings.wakeWord, { enabled: false, phrase: 'Hey Zero', sensitivity: 'normal' });
});

test('wake word settings are sanitised on update', () => {
  const store = new ConfigStore({ dir: tmpDir(), env: {} });
  store.updateSettings({ wakeWord: { enabled: true, phrase: '  Hey,   Zero!!  ', sensitivity: 'extreme' } });
  assert.deepEqual(store.settings.wakeWord, { enabled: true, phrase: 'Hey Zero', sensitivity: 'normal' });
  store.updateSettings({ wakeWord: { enabled: 'yes' } });
  assert.equal(store.settings.wakeWord.enabled, true, 'wrong-typed values are ignored, previous value kept');
  store.updateSettings({ wakeWord: { phrase: '1234 !!!' } });
  assert.equal(store.settings.wakeWord.phrase, 'Hey Zero', 'phrase without letters falls back to default');
  store.updateSettings({ wakeWord: { phrase: 'x'.repeat(100) } });
  assert.equal(store.settings.wakeWord.phrase.length, 40);
});

test('chat key is separate from the OpenAI key, and falls back to it', () => {
  const store = new ConfigStore({ dir: tmpDir(), env: {} });
  store.setSecret('openaiApiKey', 'sk-openai');
  assert.equal(store.runtime().llm.apiKey, 'sk-openai', 'no chat key set: chat falls back to the OpenAI key');
  assert.equal(store.runtime().voice.stt.apiKey, 'sk-openai');
  assert.equal(store.runtime().voice.tts.apiKey, 'sk-openai');

  store.setSecret('llmApiKey', 'nvapi-chat');
  assert.equal(store.runtime().llm.apiKey, 'nvapi-chat', 'chat uses its own key');
  assert.equal(store.runtime().voice.stt.engine, 'nvidia', 'speech-to-text uses the NVIDIA chat key');
  assert.equal(store.runtime().voice.stt.apiKey, 'nvapi-chat');
  assert.equal(store.runtime().voice.tts.apiKey, 'sk-openai', 'speech output keeps the OpenAI key');
  assert.equal(store.publicView().secretsSet.llmApiKey, true);
});

test('an NVIDIA key in the chat slot never reaches OpenAI', () => {
  const store = new ConfigStore({ dir: tmpDir(), env: {} });
  store.setSecret('llmApiKey', 'nvapi-chat');
  assert.equal(store.runtime().voice.tts.engine, 'windows', 'no OpenAI or Fish key: the app uses the Windows voice');
  assert.equal(store.runtime().voice.tts.apiKey, '');
  assert.equal(store.runtime().voice.stt.apiKey, 'nvapi-chat', 'speech-to-text goes to NVIDIA only');
});

test('clearing the OpenAI key removes it from voice and chat fallback', () => {
  const store = new ConfigStore({ dir: tmpDir(), env: {} });
  store.setSecret('openaiApiKey', 'nvapi-wrong-slot');
  store.setSecret('openaiApiKey', '');
  assert.equal(store.runtime().voice.stt.apiKey, '');
  assert.equal(store.runtime().voice.tts.apiKey, '');
  assert.equal(store.runtime().llm.apiKey, '');
});

test('LLM_API_KEY environment variable is used for chat', () => {
  const store = new ConfigStore({ dir: tmpDir(), env: { LLM_API_KEY: 'nvapi-env' } });
  assert.equal(store.runtime().llm.apiKey, 'nvapi-env');
});
