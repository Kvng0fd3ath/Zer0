'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConfigStore } = require('../src/core/config');

// Mirrors the app's codec: async-only, no synchronous decrypt at all.
function asyncOnlyCodec(calls) {
  return {
    async encryptAsync(s) {
      calls.push('encryptAsync');
      return `enc:${Buffer.from(s).toString('base64')}`;
    },
    async decryptAsync(s) {
      calls.push('decryptAsync');
      return Buffer.from(s.slice(4), 'base64').toString();
    },
  };
}

test('keys saved with the async codec load at startup and never use a sync decrypt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0-secrets-'));
  const calls = [];
  const first = new ConfigStore({ dir, codec: asyncOnlyCodec(calls), env: {} });
  await first.setSecretAsync('llmApiKey', '  nvapi-test-key  ');
  await first.setSecretAsync('fishApiKey', 'fish-test-key');

  const raw = fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8');
  assert.ok(!raw.includes('nvapi-test-key') && !raw.includes('fish-test-key'), 'keys must not be stored in plaintext');

  const second = new ConfigStore({ dir, codec: asyncOnlyCodec(calls), env: {} });
  await second.loadSecrets();
  assert.equal(second.getSecret('llmApiKey'), 'nvapi-test-key');
  assert.equal(second.getSecret('fishApiKey'), 'fish-test-key');
  assert.equal(second.publicView().secretsSet.fishApiKey, true);
  assert.ok(calls.includes('decryptAsync'));
});

test('clearing a key with setSecretAsync removes it from memory and disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0-secrets-'));
  const store = new ConfigStore({ dir, codec: asyncOnlyCodec([]), env: { FISH_API_KEY: '' } });
  await store.setSecretAsync('fishApiKey', 'fish-x');
  await store.setSecretAsync('fishApiKey', '');
  assert.equal(store.getSecret('fishApiKey'), '');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')).fishApiKey, undefined);
});

test('an unreadable saved key falls back to the environment after loading', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0-secrets-'));
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ fishApiKey: 'enc:not-valid' }));
  const codec = { async decryptAsync() { throw new Error('bad key'); }, async encryptAsync(s) { return s; } };
  const store = new ConfigStore({ dir, codec, env: { FISH_API_KEY: 'from-env' } });
  await store.loadSecrets();
  assert.equal(store.getSecret('fishApiKey'), 'from-env');
});

test('loaded secrets are served from memory even if the codec would now throw', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0-secrets-'));
  const calls = [];
  const writer = new ConfigStore({ dir, codec: asyncOnlyCodec(calls), env: {} });
  await writer.setSecretAsync('openaiApiKey', 'sk-live');
  const codec = { ...asyncOnlyCodec([]), decrypt() { throw new Error('sync call'); } };
  const store = new ConfigStore({ dir, codec, env: {} });
  await store.loadSecrets();
  assert.equal(store.getSecret('openaiApiKey'), 'sk-live');
});
