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
