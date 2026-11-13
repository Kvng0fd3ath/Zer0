'use strict';

/**
 * Read-only access to Gmail and Outlook inboxes.
 *
 * Privacy rules this module follows:
 * - Mail is only read on this PC and returned to the Zer0 window. Nothing here sends mail
 *   text to a model, and nothing is written to disk.
 * - Errors never include tokens or message contents.
 */

const crypto = require('node:crypto');
const http = require('node:http');

const PROVIDERS = Object.freeze({
  gmail: {
    label: 'Gmail',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    redirectHost: '127.0.0.1',
  },
  outlook: {
    label: 'Outlook',
    authUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
    scope: 'Mail.Read offline_access',
    redirectHost: 'localhost',
  },
});

const MAX_MESSAGES = 20;
const PREVIEW_CHARS = 200;
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

class EmailError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'EmailError';
    this.status = status;
  }
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE pair (RFC 7636, S256). The verifier stays in memory and is only sent to the token endpoint. */
function makePkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge, state: base64url(crypto.randomBytes(16)) };
}

function provider(name) {
  const p = PROVIDERS[name];
  if (!p) throw new EmailError('Unknown mail provider.');
  return p;
}

function authUrl(name, { clientId, redirectUri, challenge, state }) {
  const p = provider(name);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: p.scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  if (name === 'gmail') {
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
  }
  return `${p.authUrl}?${params.toString()}`;
}

/**
 * Start a one-shot listener on 127.0.0.1 for the sign-in redirect.
 * Resolves with { code, state } or rejects on error or timeout.
 */
function startCallbackServer(name) {
  const p = provider(name);
  let server;
  let timer;
  const result = new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Zer0</title><p>You can close this window and return to Zer0.</p>');
      clearTimeout(timer);
      if (error) reject(new EmailError(`${p.label} sign-in was cancelled.`));
      else if (!code) reject(new EmailError(`${p.label} sign-in did not return a code.`));
      else resolve({ code, state });
    });
    timer = setTimeout(() => reject(new EmailError(`${p.label} sign-in timed out. Try again.`)), CALLBACK_TIMEOUT_MS);
  });
  result.catch(() => {}); // the caller awaits it; avoid an unhandled rejection on close

  return new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveStart({
        redirectUri: `http://${p.redirectHost}:${port}/callback`,
        result,
        close() {
          clearTimeout(timer);
          server.close();
        },
      });
    });
  });
}

async function postForm(url, params, fetchImpl, label) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new EmailError(`Could not reach ${label} (${err.message}).`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!res.ok) {
    // Only the provider's short error description, never the raw body.
    const detail = data?.error_description || data?.error?.message || data?.error || '';
    throw new EmailError(`${label} refused the request (HTTP ${res.status})${detail ? `: ${String(detail).slice(0, 160)}` : '.'}`, { status: res.status });
  }
  return data || {};
}

/** Trade the sign-in code for tokens. */
async function exchangeCode(name, { clientId, clientSecret = '', code, verifier, redirectUri, fetchImpl = globalThis.fetch }) {
  const p = provider(name);
  const params = {
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  };
  if (name === 'gmail' && clientSecret) params.client_secret = clientSecret;
  const data = await postForm(p.tokenUrl, params, fetchImpl, `${p.label} sign-in`);
  if (!data.refresh_token) {
    throw new EmailError(`${p.label} did not return a refresh token. Remove Zer0 from your account and connect again.`);
  }
  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

/** Get a fresh access token from a stored refresh token. Returns a new refresh token if the provider rotated it. */
async function refreshAccess(name, { clientId, clientSecret = '', refreshToken, fetchImpl = globalThis.fetch }) {
  const p = provider(name);
  const params = { client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken };
  if (name === 'gmail' && clientSecret) params.client_secret = clientSecret;
  if (name === 'outlook') params.scope = p.scope;
  const data = await postForm(p.tokenUrl, params, fetchImpl, p.label);
  return { accessToken: data.access_token, refreshToken: data.refresh_token || refreshToken };
}

function previewText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
}

function headerValue(headers, name) {
  const h = (headers || []).find((x) => String(x.name).toLowerCase() === name.toLowerCase());
  return h ? String(h.value || '') : '';
}

/** Gmail "From" looks like: Name <address@example.com>. */
function parseFrom(raw) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(raw || '');
  if (m) return { name: m[1].trim() || m[2], address: m[2].trim() };
  return { name: (raw || '').trim() || 'Unknown sender', address: (raw || '').trim() };
}

function normalizeGmail(msg) {
  const from = parseFrom(headerValue(msg.payload?.headers, 'From'));
  const date = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : '';
  return {
    id: msg.id,
    from: from.name,
    fromAddress: from.address,
    subject: headerValue(msg.payload?.headers, 'Subject') || '(no subject)',
    date,
    preview: previewText(msg.snippet),
  };
}

function normalizeOutlook(msg) {
  return {
    id: msg.id,
    from: msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || 'Unknown sender',
    fromAddress: msg.from?.emailAddress?.address || '',
    subject: msg.subject || '(no subject)',
    date: msg.receivedDateTime || '',
    preview: previewText(msg.bodyPreview),
  };
}

async function getJson(url, accessToken, fetchImpl, label) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new EmailError(`Could not reach ${label} (${err.message}).`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data?.error?.message || '';
    throw new EmailError(`${label} returned HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 160)}` : '.'}`, { status: res.status });
  }
  return data || {};
}

/** Newest inbox messages, metadata only. */
async function fetchInbox(name, { accessToken, fetchImpl = globalThis.fetch, max = MAX_MESSAGES }) {
  const n = Math.min(Math.max(1, Number(max) || MAX_MESSAGES), MAX_MESSAGES);
  if (name === 'gmail') {
    const list = await getJson(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=${n}`,
      accessToken, fetchImpl, 'Gmail',
    );
    const ids = (list.messages || []).map((m) => m.id);
    const messages = await Promise.all(ids.map((id) => getJson(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`
        + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date',
      accessToken, fetchImpl, 'Gmail',
    )));
    return messages.map((m) => ({ ...normalizeGmail(m), account: 'gmail' }));
  }
  if (name === 'outlook') {
    const url = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages'
      + `?$top=${n}&$select=id,subject,from,receivedDateTime,bodyPreview&$orderby=receivedDateTime%20desc`;
    const data = await getJson(url, accessToken, fetchImpl, 'Outlook');
    return (data.value || []).map((m) => ({ ...normalizeOutlook(m), account: 'outlook' }));
  }
  throw new EmailError('Unknown mail provider.');
}

module.exports = {
  PROVIDERS,
  MAX_MESSAGES,
  EmailError,
  makePkce,
  authUrl,
  startCallbackServer,
  exchangeCode,
  refreshAccess,
  fetchInbox,
  parseFrom,
  normalizeGmail,
  normalizeOutlook,
  previewText,
};
