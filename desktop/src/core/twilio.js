'use strict';

const E164 = /^\+[1-9]\d{6,14}$/;
const MAX_SMS_LENGTH = 1600;
const MAX_CALL_MESSAGE_LENGTH = 500;

/** Strip common formatting; returns an E.164 string or null. */
function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  const compact = input.replace(/[\s().-]/g, '');
  return E164.test(compact) ? compact : null;
}

function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

class TwilioError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'TwilioError';
    this.status = status;
    this.code = code;
  }
}

class TwilioClient {
  /**
   * @param {{accountSid: string, authToken: string, fromNumber: string, fetchImpl?: typeof fetch, baseUrl?: string}} opts
   */
  constructor({ accountSid, authToken, fromNumber, fetchImpl = globalThis.fetch, baseUrl = 'https://api.twilio.com' }) {
    this.accountSid = accountSid || '';
    this.authToken = authToken || '';
    this.fromNumber = fromNumber || '';
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  get isConfigured() {
    return Boolean(this.accountSid && this.authToken && normalizePhone(this.fromNumber));
  }

  #assertConfigured() {
    if (!this.isConfigured) {
      throw new TwilioError('Twilio is not configured. Add the Account SID, Auth Token and a valid From number in Settings.');
    }
  }

  async #post(resource, params) {
    const url = `${this.baseUrl}/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/${resource}.json`;
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    let res;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Basic ${auth}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new TwilioError(`Could not reach Twilio (${err.message}).`);
    }
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!res.ok) {
      throw new TwilioError(data?.message || `Twilio request failed with HTTP ${res.status}.`, {
        status: res.status,
        code: data?.code,
      });
    }
    return data;
  }

  /** Send an SMS. `to` must already be E.164. */
  async sendSms({ to, body }) {
    this.#assertConfigured();
    const dest = normalizePhone(to);
    if (!dest) throw new TwilioError('Destination must be a phone number in E.164 format, e.g. +15551234567.');
    const text = String(body ?? '').trim();
    if (!text) throw new TwilioError('Message body is empty.');
    if (text.length > MAX_SMS_LENGTH) throw new TwilioError(`Message is too long (max ${MAX_SMS_LENGTH} characters).`);
    const data = await this.#post('Messages', { To: dest, From: normalizePhone(this.fromNumber), Body: text });
    return { sid: data.sid, status: data.status, to: dest };
  }

  /** Place an outbound call that reads `message` aloud with Twilio's text-to-speech. */
  async placeCall({ to, message }) {
    this.#assertConfigured();
    const dest = normalizePhone(to);
    if (!dest) throw new TwilioError('Destination must be a phone number in E.164 format, e.g. +15551234567.');
    const text = String(message ?? '').trim();
    if (!text) throw new TwilioError('Call message is empty.');
    if (text.length > MAX_CALL_MESSAGE_LENGTH) {
      throw new TwilioError(`Call message is too long (max ${MAX_CALL_MESSAGE_LENGTH} characters).`);
    }
    const twiml = `<Response><Say voice="Polly.Joanna">${escapeXml(text)}</Say><Pause length="1"/><Say voice="Polly.Joanna">Goodbye.</Say></Response>`;
    const data = await this.#post('Calls', { To: dest, From: normalizePhone(this.fromNumber), Twiml: twiml });
    return { sid: data.sid, status: data.status, to: dest };
  }
}

module.exports = { TwilioClient, TwilioError, normalizePhone, escapeXml, MAX_SMS_LENGTH, MAX_CALL_MESSAGE_LENGTH };
