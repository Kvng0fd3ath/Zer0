'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stripEmotionTags, emotionInstruction, EMOTIONS } = require('../src/core/emotion');
const { Companion, systemPrompt } = require('../src/core/agent');
const { createToolRegistry } = require('../src/core/tools');
const { ActionQueue } = require('../src/core/actions');

test('stripEmotionTags removes only the known expression tags', () => {
  assert.equal(stripEmotionTags('(calm) Good morning, Sam.'), 'Good morning, Sam.');
  assert.equal(stripEmotionTags('Sure. (Happy) Done.'), 'Sure. Done.');
  assert.equal(stripEmotionTags('See (below) for details.'), 'See (below) for details.');
  assert.equal(stripEmotionTags('Line one.\n(sad) Line two.'), 'Line one.\nLine two.');
  assert.equal(stripEmotionTags(null), '');
});

test('every listed emotion is stripped', () => {
  for (const e of EMOTIONS) assert.equal(stripEmotionTags(`(${e}) hi`), 'hi');
});

test('the emotion instruction is only added when Fish is the reply voice', () => {
  const base = { assistantName: 'Zer0', userName: 'Sam' };
  const now = new Date('2026-11-12T15:00:00Z');
  const plain = systemPrompt({ ...base, voice: { tts: { engine: 'windows' } } }, now);
  const none = systemPrompt(base, now);
  const fish = systemPrompt({ ...base, voice: { tts: { engine: 'fish' } } }, now);
  assert.equal(plain.includes('Fish Audio'), false);
  assert.equal(none.includes('Fish Audio'), false);
  assert.equal(fish.includes(emotionInstruction()), true);
  assert.match(fish, /\(calm\)/);
});

test('Companion returns tagged text for speech and plain text for the screen and history', async () => {
  const runtime = { assistantName: 'Zer0', userName: 'Sam', llm: { baseUrl: 'https://x', model: 'm', apiKey: 'k' }, voice: { tts: { engine: 'fish' } } };
  const chat = async () => ({ role: 'assistant', content: '(calm) Your meeting moved to three.' });
  const queue = new ActionQueue();
  const tools = createToolRegistry({ getContacts: () => [], getTwilio: () => null, openExternal: async () => {} });
  const companion = new Companion({ getRuntime: () => runtime, tools, queue, chat });

  const res = await companion.respond('when is my meeting');
  assert.equal(res.reply, 'Your meeting moved to three.');
  assert.equal(res.spoken, '(calm) Your meeting moved to three.');
  assert.equal(companion.transcript()[1].content, 'Your meeting moved to three.');
});

test('without Fish, spoken equals reply', async () => {
  const runtime = { assistantName: 'Zer0', llm: { baseUrl: 'https://x', model: 'm', apiKey: 'k' }, voice: { tts: { engine: 'windows' } } };
  const chat = async () => ({ role: 'assistant', content: 'Plain answer.' });
  const companion = new Companion({
    getRuntime: () => runtime,
    tools: createToolRegistry({ getContacts: () => [], getTwilio: () => null, openExternal: async () => {} }),
    queue: new ActionQueue(),
    chat,
  });
  const res = await companion.respond('hi');
  assert.equal(res.spoken, res.reply);
});
