'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TwilioClient, normalizePhone, escapeXml } = require('../src/core/twilio');

function fakeFetch(response = { sid: 'SM123', status: 'queued' }, { ok = true, status = 201 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, text: async () => JSON.stringify(ok ? response : { message: 'Invalid To', code: 21211 }) };
  };
  return { fn, calls };
}

const config = { accountSid: 'AC123', authToken: 'secret', fromNumber: '+15550001111' };

test('normalizePhone accepts E.164 and common formatting', () => {
  assert.equal(normalizePhone('+1 (555) 123-4567'), '+15551234567');
  assert.equal(normalizePhone('5551234567'), null);
  assert.equal(normalizePhone('+0123'), null);
  assert.equal(normalizePhone(undefined), null);
});

test('client reports unconfigured state', () => {
  assert.equal(new TwilioClient({}).isConfigured, false);
  assert.equal(new TwilioClient({ ...config, fromNumber: 'nope' }).isConfigured, false);
  assert.equal(new TwilioClient(config).isConfigured, true);
});

test('sendSms posts form data with basic auth', async () => {
  const { fn, calls } = fakeFetch();
  const client = new TwilioClient({ ...config, fetchImpl: fn });
  const res = await client.sendSms({ to: '+15551234567', body: 'Hi there' });
  assert.equal(res.sid, 'SM123');
  assert.match(calls[0].url, /\/2010-04-01\/Accounts\/AC123\/Messages\.json$/);
  assert.equal(calls[0].init.headers.authorization, `Basic ${Buffer.from('AC123:secret').toString('base64')}`);
  const params = new URLSearchParams(calls[0].init.body);
  assert.equal(params.get('To'), '+15551234567');
  assert.equal(params.get('From'), '+15550001111');
  assert.equal(params.get('Body'), 'Hi there');
});

test('sendSms rejects bad numbers, empty and oversized bodies before any request', async () => {
  const { fn, calls } = fakeFetch();
  const client = new TwilioClient({ ...config, fetchImpl: fn });
  await assert.rejects(client.sendSms({ to: 'bob', body: 'x' }), /E\.164/);
  await assert.rejects(client.sendSms({ to: '+15551234567', body: '   ' }), /empty/);
  await assert.rejects(client.sendSms({ to: '+15551234567', body: 'a'.repeat(1601) }), /too long/);
  assert.equal(calls.length, 0);
});

test('placeCall builds escaped TwiML and surfaces Twilio errors', async () => {
  const ok = fakeFetch({ sid: 'CA999', status: 'queued' });
  const client = new TwilioClient({ ...config, fetchImpl: ok.fn });
  const res = await client.placeCall({ to: '+15551234567', message: 'Dinner <at> 7 & bring "wine"' });
  assert.equal(res.sid, 'CA999');
  const twiml = new URLSearchParams(ok.calls[0].init.body).get('Twiml');
  assert.ok(twiml.includes('Dinner &lt;at&gt; 7 &amp; bring &quot;wine&quot;'));
  assert.match(ok.calls[0].url, /\/Calls\.json$/);

  const bad = fakeFetch(null, { ok: false, status: 400 });
  const client2 = new TwilioClient({ ...config, fetchImpl: bad.fn });
  await assert.rejects(client2.placeCall({ to: '+15551234567', message: 'hi' }), (err) => err.message === 'Invalid To' && err.code === 21211);
});

test('escapeXml escapes all five reserved characters', () => {
  assert.equal(escapeXml(`<&>"'`), '&lt;&amp;&gt;&quot;&apos;');
});
