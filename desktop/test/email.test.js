'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const email = require('../src/core/email');
const { createToolRegistry } = require('../src/core/tools');
const { ConfigStore, SECRET_NAMES } = require('../src/core/config');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

test('PKCE matches the RFC 7636 example', () => {
  const p = email.makePkce();
  assert.match(p.verifier, /^[A-Za-z0-9_-]{43}$/);
  const expected = crypto.createHash('sha256').update(p.verifier).digest('base64url');
  assert.equal(p.challenge, expected);
  // RFC 7636 appendix B
  const rfcChallenge = crypto.createHash('sha256').update('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk').digest('base64url');
  assert.equal(rfcChallenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('authorization URLs ask for read-only mail access with PKCE', () => {
  const g = new URL(email.authUrl('gmail', { clientId: 'cid', redirectUri: 'http://127.0.0.1:5000/callback', challenge: 'c', state: 's' }));
  assert.equal(g.origin + g.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(g.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
  assert.equal(g.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(g.searchParams.get('access_type'), 'offline');
  assert.equal(g.searchParams.get('state'), 's');

  const o = new URL(email.authUrl('outlook', { clientId: 'cid', redirectUri: 'http://localhost:5001/callback', challenge: 'c', state: 's' }));
  assert.equal(o.searchParams.get('scope'), 'Mail.Read offline_access');
  assert.equal(o.searchParams.get('access_type'), null);
});

test('callback listener receives the code and state, then closes', async () => {
  const server = await email.startCallbackServer('gmail');
  assert.match(server.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const port = new URL(server.redirectUri).port;
  await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/callback?code=abc&state=xyz`, (res) => {
      res.resume();
      res.on('end', resolve);
    }).on('error', reject);
  });
  assert.deepEqual(await server.result, { code: 'abc', state: 'xyz' });
  server.close();
});

test('a cancelled sign-in rejects with a plain message', async () => {
  const server = await email.startCallbackServer('gmail');
  const port = new URL(server.redirectUri).port;
  http.get(`http://127.0.0.1:${port}/callback?error=access_denied`, (res) => res.resume());
  await assert.rejects(server.result, /cancelled/);
  server.close();
});

test('exchangeCode sends the verifier, and the client secret only for Gmail', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push({ url, body: new URLSearchParams(init.body) });
    return jsonResponse(200, { access_token: 'AT', refresh_token: 'RT' });
  };
  const g = await email.exchangeCode('gmail', { clientId: 'cid', clientSecret: 'sec', code: 'code1', verifier: 'ver', redirectUri: 'http://127.0.0.1:1/callback', fetchImpl });
  assert.deepEqual(g, { accessToken: 'AT', refreshToken: 'RT' });
  assert.equal(bodies[0].body.get('code_verifier'), 'ver');
  assert.equal(bodies[0].body.get('client_secret'), 'sec');
  await email.exchangeCode('outlook', { clientId: 'cid', clientSecret: 'sec', code: 'c', verifier: 'v', redirectUri: 'http://localhost:2/callback', fetchImpl });
  assert.equal(bodies[1].body.get('client_secret'), null);
  assert.match(bodies[1].url, /login\.microsoftonline\.com\/consumers/);
});

test('a missing refresh token is reported, not silently accepted', async () => {
  const fetchImpl = async () => jsonResponse(200, { access_token: 'AT' });
  await assert.rejects(
    email.exchangeCode('outlook', { clientId: 'c', code: 'x', verifier: 'v', redirectUri: 'http://localhost:1/callback', fetchImpl }),
    /did not return a refresh token/,
  );
});

test('error replies never echo the token fields', async () => {
  const fetchImpl = async () => jsonResponse(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.', access_token: 'LEAK-ME' });
  await assert.rejects(
    email.refreshAccess('gmail', { clientId: 'c', refreshToken: 'r', fetchImpl }),
    (err) => {
      assert.match(err.message, /expired or revoked/);
      assert.ok(!err.message.includes('LEAK-ME'));
      return true;
    },
  );
});

test('refreshAccess keeps the old refresh token unless the provider rotates it', async () => {
  const fetchImpl = async () => jsonResponse(200, { access_token: 'NEW' });
  const out = await email.refreshAccess('outlook', { clientId: 'c', refreshToken: 'OLD', fetchImpl });
  assert.deepEqual(out, { accessToken: 'NEW', refreshToken: 'OLD' });
});

test('From headers are split into a name and an address', () => {
  assert.deepEqual(email.parseFrom('Jane Doe <jane@example.com>'), { name: 'Jane Doe', address: 'jane@example.com' });
  assert.deepEqual(email.parseFrom('"Bank Alerts" <alerts@bank.test>'), { name: 'Bank Alerts', address: 'alerts@bank.test' });
  assert.deepEqual(email.parseFrom('solo@example.com'), { name: 'solo@example.com', address: 'solo@example.com' });
});

test('previews are one line and capped', () => {
  const long = 'word '.repeat(100);
  const out = email.previewText(`line one\n\n   line two  ${long}`);
  assert.ok(!out.includes('\n'));
  assert.ok(out.length <= 200);
  assert.ok(out.startsWith('line one line two'));
});

test('Gmail metadata maps to the message shape', () => {
  const msg = email.normalizeGmail({
    id: 'm1',
    snippet: 'Hello there',
    internalDate: '1767225600000',
    payload: { headers: [{ name: 'From', value: 'Sam <sam@x.test>' }, { name: 'subject', value: 'Lunch?' }] },
  });
  assert.equal(msg.from, 'Sam');
  assert.equal(msg.fromAddress, 'sam@x.test');
  assert.equal(msg.subject, 'Lunch?');
  assert.equal(msg.date, new Date(1767225600000).toISOString());
  assert.equal(msg.preview, 'Hello there');
});

test('fetchInbox lists Gmail inbox messages with the access token', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    if (url.includes('/messages?')) return jsonResponse(200, { messages: [{ id: 'a' }, { id: 'b' }] });
    const id = url.split('/').pop().split('?')[0];
    return jsonResponse(200, {
      id,
      snippet: `snip ${id}`,
      internalDate: '1767225600000',
      payload: { headers: [{ name: 'From', value: `Person ${id} <${id}@x.test>` }, { name: 'Subject', value: `Subj ${id}` }] },
    });
  };
  const out = await email.fetchInbox('gmail', { accessToken: 'TOKEN', fetchImpl });
  assert.equal(out.length, 2);
  assert.equal(out[0].account, 'gmail');
  assert.equal(out[1].subject, 'Subj b');
  assert.ok(calls.every((c) => c.auth === 'Bearer TOKEN'));
  assert.ok(calls[0].url.includes('maxResults=20'));
  assert.ok(calls.slice(1).every((c) => c.url.includes('format=metadata')));
});

test('fetchInbox lists Outlook inbox messages', async () => {
  const fetchImpl = async (url) => {
    assert.ok(url.startsWith('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages'));
    assert.ok(url.includes('%24top=20') || url.includes('$top=20'));
    return jsonResponse(200, {
      value: [{ id: 'o1', subject: 'Hi', from: { emailAddress: { name: 'Kim', address: 'kim@x.test' } }, receivedDateTime: '2026-11-12T10:00:00Z', bodyPreview: 'Body text' }],
    });
  };
  const out = await email.fetchInbox('outlook', { accessToken: 'T', fetchImpl });
  assert.deepEqual(out, [{
    id: 'o1', from: 'Kim', fromAddress: 'kim@x.test', subject: 'Hi', date: '2026-11-12T10:00:00Z', preview: 'Body text', account: 'outlook',
  }]);
});

test('the chat assistant has no email tools, so mail never reaches a model', () => {
  const tools = createToolRegistry({ getContacts: () => [], getTwilio: () => null, openExternal: async () => {} });
  const names = tools.specs().map((s) => s.function.name);
  assert.ok(names.length > 0);
  for (const n of names) assert.ok(!/mail|inbox|gmail|outlook/i.test(n), `unexpected tool ${n}`);
});

test('email secrets are in the encrypted store and never shown to the page', () => {
  for (const name of ['gmailClientId', 'gmailClientSecret', 'outlookClientId', 'gmailRefreshToken', 'outlookRefreshToken']) {
    assert.ok(SECRET_NAMES.includes(name), name);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0-email-'));
  const store = new ConfigStore({ dir, codec: { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.slice(4) }, env: {} });
  store.setSecret('gmailRefreshToken', 'REFRESH-SECRET');
  const view = store.publicView();
  assert.equal(view.secretsSet.gmailRefreshToken, true);
  assert.ok(!JSON.stringify(view).includes('REFRESH-SECRET'));
});
