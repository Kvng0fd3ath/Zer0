'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Companion } = require('../src/core/agent');
const { createToolRegistry } = require('../src/core/tools');
const { ActionQueue } = require('../src/core/actions');
const { TwilioClient } = require('../src/core/twilio');

const runtime = {
  assistantName: 'Zer0',
  userName: 'Sam',
  llm: { baseUrl: 'https://x', model: 'm', apiKey: 'k' },
  contacts: [{ name: 'Mom', phone: '+15551230001' }],
};

function build(script) {
  // `script` is an array of model replies (assistant messages) consumed in order.
  const seenMessages = [];
  let i = 0;
  const chat = async (args) => {
    seenMessages.push(args.messages);
    const next = script[i];
    i += 1;
    if (!next) throw new Error('script exhausted');
    if (next instanceof Error) throw next;
    return next;
  };
  const sent = [];
  const twilio = new TwilioClient({
    accountSid: 'AC1',
    authToken: 't',
    fromNumber: '+15550001111',
    fetchImpl: async (url, init) => {
      sent.push(new URLSearchParams(init.body));
      return { ok: true, status: 201, text: async () => JSON.stringify({ sid: 'SM9', status: 'queued' }) };
    },
  });
  const queue = new ActionQueue();
  const tools = createToolRegistry({ getContacts: () => runtime.contacts, getTwilio: () => twilio, openExternal: async () => {} });
  const companion = new Companion({ getRuntime: () => runtime, tools, queue, chat, clock: () => new Date('2026-11-12T15:00:00Z') });
  return { companion, queue, seenMessages, sent };
}

const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('plain answer returns reply with no actions', async () => {
  const { companion } = build([{ role: 'assistant', content: 'Good afternoon, Sam.' }]);
  const res = await companion.respond('hello');
  assert.equal(res.reply, 'Good afternoon, Sam.');
  assert.deepEqual(res.actions, []);
  assert.equal(companion.transcript().length, 2);
});

test('text request queues an action and does NOT send until confirmed', async () => {
  const { companion, queue, sent } = build([
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'send_text', { to: 'Mom', body: 'Be there soon' })] },
    { role: 'assistant', content: 'I have queued that text to Mom. Confirm to send it.' },
  ]);
  const res = await companion.respond('text mom be there soon');
  assert.equal(res.actions.length, 1);
  assert.equal(res.actions[0].status, 'pending');
  assert.match(res.reply, /Confirm/);
  assert.equal(sent.length, 0, 'nothing sent before confirmation');

  const done = await companion.confirm(res.actions[0].id);
  assert.equal(done.status, 'done');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].get('To'), '+15551230001');
  assert.equal(sent[0].get('Body'), 'Be there soon');
  assert.equal(queue.list().length, 0);
});

test('cancelling a queued call never reaches Twilio', async () => {
  const { companion, sent } = build([
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'place_call', { to: 'Mom', message: 'Hi' })] },
    { role: 'assistant', content: 'Queued.' },
  ]);
  const res = await companion.respond('call mom');
  const cancelled = companion.cancel(res.actions[0].id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(sent.length, 0);
});

test('tool errors are returned to the model, not thrown', async () => {
  const { companion, seenMessages } = build([
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'send_text', { to: 'Nobody', body: 'x' })] },
    { role: 'assistant', content: 'Who should I text?' },
  ]);
  const res = await companion.respond('text nobody');
  assert.equal(res.reply, 'Who should I text?');
  assert.deepEqual(res.actions, []);
  const toolMsg = seenMessages[1].find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /No contact named/);
});

test('unknown tool names and malformed arguments are handled gracefully', async () => {
  const bad = { id: 'c2', type: 'function', function: { name: 'format_disk', arguments: '{}' } };
  const malformed = { id: 'c3', type: 'function', function: { name: 'get_time', arguments: '{not json' } };
  const { companion, seenMessages } = build([
    { role: 'assistant', content: null, tool_calls: [bad, malformed] },
    { role: 'assistant', content: 'Sorry, that did not work.' },
  ]);
  await companion.respond('do something');
  const toolMsgs = seenMessages[1].filter((m) => m.role === 'tool');
  assert.match(toolMsgs[0].content, /Unknown tool/);
  assert.match(toolMsgs[1].content, /not valid JSON/);
});

test('a failing model call rolls back history so the next request still works', async () => {
  const { companion } = build([new Error('network down'), { role: 'assistant', content: 'Back online.' }]);
  await assert.rejects(companion.respond('first'), /network down/);
  assert.equal(companion.transcript().length, 0);
  const res = await companion.respond('second');
  assert.equal(res.reply, 'Back online.');
});

test('system prompt carries the assistant name and current time', async () => {
  const { companion, seenMessages } = build([{ role: 'assistant', content: 'ok' }]);
  await companion.respond('hi');
  const sys = seenMessages[0][0];
  assert.equal(sys.role, 'system');
  assert.match(sys.content, /You are Zer0/);
  assert.match(sys.content, /2026/);
  assert.match(sys.content, /Sam/);
});

test('confirm outcome is fed back to the model on the next turn', async () => {
  const { companion, seenMessages } = build([
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'send_text', { to: 'Mom', body: 'hey' })] },
    { role: 'assistant', content: 'Queued.' },
    { role: 'assistant', content: 'Done, it was sent.' },
  ]);
  const res = await companion.respond('text mom hey');
  await companion.confirm(res.actions[0].id);
  await companion.respond('thanks');
  const lastSystem = seenMessages[2].filter((m) => m.role === 'system').at(-1);
  assert.match(lastSystem.content, /Confirmed and sent/);
});
