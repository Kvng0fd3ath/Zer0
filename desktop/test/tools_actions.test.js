'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createToolRegistry } = require('../src/core/tools');
const { ActionQueue, PENDING_TTL_MS } = require('../src/core/actions');
const { TwilioClient } = require('../src/core/twilio');

const contacts = [
  { name: 'Mom', phone: '+15551230001' },
  { name: 'Mike Smith', phone: '+15551230002' },
  { name: 'Mike Jones', phone: '+15551230003' },
];

function setup({ configured = true, now = new Date('2026-11-12T15:00:00Z') } = {}) {
  const sent = [];
  const twilio = new TwilioClient({
    accountSid: configured ? 'AC1' : '',
    authToken: configured ? 't' : '',
    fromNumber: configured ? '+15550001111' : '',
    fetchImpl: async (url, init) => {
      sent.push({ url, body: new URLSearchParams(init.body) });
      return { ok: true, status: 201, text: async () => JSON.stringify({ sid: 'SM1', status: 'queued' }) };
    },
  });
  const opened = [];
  const tools = createToolRegistry({
    getContacts: () => contacts,
    getTwilio: () => twilio,
    openExternal: async (u) => opened.push(u),
    clock: () => now,
  });
  return { tools, sent, opened, twilio };
}

test('get_time returns ISO and local strings from the injected clock', async () => {
  const { tools } = setup();
  const res = await tools.get('get_time').run({}, {});
  assert.equal(res.iso, '2026-11-12T15:00:00.000Z');
  assert.match(res.local, /2026/);
});

test('lookup_contact matches case-insensitively by substring', async () => {
  const { tools } = setup();
  const res = await tools.get('lookup_contact').run({ name: 'mike' }, {});
  assert.equal(res.matches.length, 2);
});

test('open_url only allows http and https', async () => {
  const { tools, opened } = setup();
  const open = tools.get('open_url');
  await open.run({ url: 'https://example.com/a' }, {});
  assert.deepEqual(opened, ['https://example.com/a']);
  await assert.rejects(open.run({ url: 'file:///etc/passwd' }, {}), /Only http and https/);
  await assert.rejects(open.run({ url: 'javascript:alert(1)' }, {}), /Only http and https/);
  await assert.rejects(open.run({ url: 'not a url' }, {}), /not a valid URL/);
});

test('send_text resolves a contact name and queues without sending', () => {
  const { tools, sent } = setup();
  const prepared = tools.get('send_text').prepare({ to: 'Mom', body: 'On my way' }, {});
  assert.match(prepared.summary, /Mom \(\+15551230001\)/);
  assert.match(prepared.summary, /On my way/);
  assert.equal(sent.length, 0, 'prepare must not send');
});

test('send_text reports ambiguous and unknown contacts to the model', () => {
  const { tools } = setup();
  const send = tools.get('send_text');
  assert.throws(() => send.prepare({ to: 'Mike', body: 'hi' }, {}), /matches several contacts/);
  assert.throws(() => send.prepare({ to: 'Zelda', body: 'hi' }, {}), /No contact named/);
});

test('send_text and place_call refuse to prepare when Twilio is not configured', () => {
  const { tools } = setup({ configured: false });
  assert.throws(() => tools.get('send_text').prepare({ to: '+15551234567', body: 'hi' }, {}), /Twilio is not configured/);
  assert.throws(() => tools.get('place_call').prepare({ to: '+15551234567', message: 'hi' }, {}), /Twilio is not configured/);
});

test('place_call summary includes the spoken message and the executor calls Twilio', async () => {
  const { tools, sent } = setup();
  const prepared = tools.get('place_call').prepare({ to: '+1 555 123 4567', message: 'Running late' }, {});
  assert.match(prepared.summary, /Call \+15551234567 and say: "Running late"/);
  assert.equal(sent.length, 0);
  await prepared.execute();
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /Calls\.json$/);
});

test('ActionQueue: confirm executes once, cancel prevents execution', async () => {
  let runs = 0;
  const queue = new ActionQueue();
  const a = queue.add({ type: 't', summary: 'A', execute: async () => { runs += 1; return { ok: 1 }; } });
  const confirmed = await queue.confirm(a.id);
  assert.equal(confirmed.status, 'done');
  assert.deepEqual(confirmed.result, { ok: 1 });
  await assert.rejects(queue.confirm(a.id), /already done/);

  const b = queue.add({ type: 't', summary: 'B', execute: async () => { runs += 1; } });
  queue.cancel(b.id);
  await assert.rejects(queue.confirm(b.id), /already cancelled/);
  assert.equal(runs, 1);
});

test('ActionQueue: failed execution is recorded, not thrown', async () => {
  const queue = new ActionQueue();
  const a = queue.add({ type: 't', summary: 'A', execute: async () => { throw new Error('boom'); } });
  const res = await queue.confirm(a.id);
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'boom');
});

test('ActionQueue: pending actions expire after the TTL', () => {
  let t = 1_000_000;
  const queue = new ActionQueue({ now: () => t });
  const a = queue.add({ type: 't', summary: 'old', execute: async () => {} });
  t += PENDING_TTL_MS + 1;
  assert.equal(queue.list().length, 0);
  assert.equal(queue.get(a.id).status, 'expired');
});
