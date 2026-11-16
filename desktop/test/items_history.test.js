'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ItemStore, ItemError } = require('../src/core/items');
const { ChatHistory, MAX_MESSAGES } = require('../src/core/chat_history');
const { Companion } = require('../src/core/agent');
const { createToolRegistry } = require('../src/core/tools');
const { ActionQueue } = require('../src/core/actions');

const NOW = new Date('2026-11-13T12:00:00Z');
const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zer0-items-')), name);
// Mirrors the app's codec: encrypted text with the same prefix format.
const codec = {
  encryptAsync: async (s) => `enc:${Buffer.from(s).toString('base64')}`,
  decryptAsync: async (s) => Buffer.from(s.slice(4), 'base64').toString(),
};

test('reminders need a future time, and notes need text', () => {
  const store = new ItemStore({ file: tmp('i.json'), clock: () => NOW });
  assert.throws(() => store.add({ kind: 'reminder', text: 'x', dueAt: '2026-11-13T11:00:00Z' }), ItemError);
  assert.throws(() => store.add({ kind: 'reminder', text: 'x', dueAt: 'not a date' }), ItemError);
  assert.throws(() => store.add({ kind: 'note', text: '   ' }), ItemError);
  assert.throws(() => store.add({ kind: 'note', text: 'a'.repeat(501) }), ItemError);
  assert.throws(() => store.add({ kind: 'other', text: 'x' }), ItemError);
  const n = store.add({ kind: 'note', text: '  buy   milk\n  ' });
  assert.equal(n.text, 'buy milk');
});

test('due reminders fire once', () => {
  const store = new ItemStore({ file: tmp('i.json'), clock: () => NOW });
  store.add({ kind: 'reminder', text: 'oven', dueAt: '2026-11-13T12:05:00Z' });
  store.add({ kind: 'reminder', text: 'later', dueAt: '2026-11-13T13:00:00Z' });
  assert.deepEqual(store.takeDue(new Date('2026-11-13T12:04:00Z')), []);
  const due = store.takeDue(new Date('2026-11-13T12:06:00Z'));
  assert.deepEqual(due.map((x) => x.text), ['oven']);
  assert.deepEqual(store.takeDue(new Date('2026-11-13T12:07:00Z')), []);
});

test('open lists skip done items and sort sensibly', () => {
  const store = new ItemStore({ file: tmp('i.json'), clock: () => NOW });
  const a = store.add({ kind: 'note', text: 'first' });
  store.clock = () => new Date(NOW.getTime() + 60_000);
  store.add({ kind: 'note', text: 'second' });
  store.complete(a.id);
  assert.deepEqual(store.open('note').map((x) => x.text), ['second']);
  assert.throws(() => store.complete('missing'), ItemError);
});

test('items survive a restart, encrypted on disk', async () => {
  const file = tmp('items.json');
  const first = new ItemStore({ file, codec, clock: () => NOW });
  first.add({ kind: 'note', text: 'secret grocery list' });
  await first.save();
  assert.ok(!fs.readFileSync(file, 'utf8').includes('grocery'), 'file must not hold plain text');
  const second = new ItemStore({ file, codec, clock: () => NOW });
  await second.load();
  assert.deepEqual(second.open('note').map((x) => x.text), ['secret grocery list']);
});

test('a corrupt items file starts empty instead of crashing', async () => {
  const file = tmp('items.json');
  fs.writeFileSync(file, '{not json');
  const store = new ItemStore({ file, clock: () => NOW });
  await store.load();
  assert.deepEqual(store.items, []);
});

test('chat history keeps only user and assistant text, capped, and round-trips', async () => {
  const file = tmp('chat.json');
  const history = new ChatHistory({ file, codec });
  const many = Array.from({ length: MAX_MESSAGES + 5 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}`, tool_calls: [] }));
  many.push({ role: 'tool', content: 'raw tool output' });
  await history.save(many);
  const loaded = await history.load();
  assert.equal(loaded.length, MAX_MESSAGES);
  assert.equal(loaded.at(-1).content, `m${MAX_MESSAGES + 4}`);
  assert.ok(loaded.every((m) => m.role === 'user' || m.role === 'assistant'));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('raw tool output'));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('m7'), 'history must be encrypted on disk');
});

test('restored history shows up as the companion transcript', async () => {
  const runtime = { assistantName: 'Zer0', llm: { baseUrl: 'https://x', model: 'm', apiKey: 'k' } };
  const companion = new Companion({
    getRuntime: () => runtime,
    tools: createToolRegistry({ getContacts: () => [], getTwilio: () => null, openExternal: async () => {} }),
    queue: new ActionQueue(),
    chat: async () => ({ role: 'assistant', content: 'ok' }),
  });
  companion.restore([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'tool', content: 'x' }]);
  assert.deepEqual(companion.transcript(), [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]);
});

function companionWith(script, items) {
  const seen = [];
  let i = 0;
  const chat = async (args) => {
    seen.push(args.messages);
    const next = script[i];
    i += 1;
    return next;
  };
  const tools = createToolRegistry({ getContacts: () => [], getTwilio: () => null, openExternal: async () => {}, items, clock: () => NOW });
  const companion = new Companion({
    getRuntime: () => ({ assistantName: 'Zer0', llm: { baseUrl: 'https://x', model: 'm', apiKey: 'k' } }),
    tools,
    queue: new ActionQueue(),
    chat,
    clock: () => NOW,
  });
  return { companion, seen };
}

test('the assistant can set a reminder and save a note through tools', async () => {
  const items = new ItemStore({ file: tmp('i.json'), clock: () => NOW });
  const { companion } = companionWith([
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'set_reminder', arguments: JSON.stringify({ text: 'Check the oven', minutes: 20 }) } }] },
    { role: 'assistant', content: 'Reminder set for 20 minutes.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'add_note', arguments: JSON.stringify({ text: 'Buy eggs' }) } }] },
    { role: 'assistant', content: 'Saved.' },
  ], items);
  await companion.respond('remind me to check the oven in 20 minutes');
  await companion.respond('note: buy eggs');
  assert.equal(items.open('reminder')[0].text, 'Check the oven');
  assert.equal(items.open('reminder')[0].dueAt, new Date(NOW.getTime() + 20 * 60_000).toISOString());
  assert.deepEqual(items.open('note').map((x) => x.text), ['Buy eggs']);
});

test('reminder tool rejects bad input with a readable error', async () => {
  const items = new ItemStore({ file: tmp('i.json'), clock: () => NOW });
  const tools = createToolRegistry({ getContacts: () => [], getTwilio: () => null, openExternal: async () => {}, items, clock: () => NOW });
  const set = tools.get('set_reminder');
  await assert.rejects(set.run({ text: 'x' }), /minutes or a time/);
  await assert.rejects(set.run({ text: 'x', minutes: 0 }), /between 1 and 10080/);
  await assert.rejects(set.run({ text: 'x', minutes: 20000 }), /between 1 and 10080/);
  await assert.rejects(set.run({ text: 'x', at: '2020-01-01T00:00:00Z' }), /in the past/);
});

test('item tools are only offered when an item store is given', () => {
  const without = createToolRegistry({ getContacts: () => [], getTwilio: () => null, openExternal: async () => {} }).names();
  assert.ok(!without.includes('set_reminder'));
  const withItems = createToolRegistry({ getContacts: () => [], getTwilio: () => null, openExternal: async () => {}, items: new ItemStore({ file: tmp('i.json') }) }).names();
  for (const n of ['set_reminder', 'list_reminders', 'add_note', 'list_notes', 'complete_item']) assert.ok(withItems.includes(n), n);
});
