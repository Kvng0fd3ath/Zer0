'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chatCompletion } = require('../src/core/llm');

function okFetch(seen) {
  return async (url) => {
    seen.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }) };
  };
}

for (const base of [
  'https://integrate.api.nvidia.com/v1',
  'https://integrate.api.nvidia.com/v1/',
  'https://integrate.api.nvidia.com/v1/chat/completions',
  'https://integrate.api.nvidia.com/v1/chat/completions/',
]) {
  test(`chat endpoint is correct for base URL ${base}`, async () => {
    const seen = [];
    await chatCompletion({ baseUrl: base, apiKey: 'k', model: 'm', messages: [], fetchImpl: okFetch(seen) });
    assert.deepEqual(seen, ['https://integrate.api.nvidia.com/v1/chat/completions']);
  });
}
