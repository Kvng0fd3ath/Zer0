'use strict';

const { normalizePhone, MAX_SMS_LENGTH, MAX_CALL_MESSAGE_LENGTH } = require('./twilio');

/**
 * Tool kinds:
 *  - 'immediate': `run(args, deps)` executes right away and returns a JSON-serialisable result.
 *  - 'confirm':   `prepare(args, deps)` validates and returns `{ summary, execute }`. Nothing
 *                 external happens until the user confirms the queued action in the UI.
 */
/** Tools for reminders and notes, backed by an ItemStore. */
function itemTools(items, clock) {
  const summarise = (x) => ({ id: x.id, text: x.text, dueAt: x.dueAt, createdAt: x.createdAt });
  return [
    {
      name: 'set_reminder',
      kind: 'immediate',
      description: 'Set a reminder that shows a Windows notification at a time. Give either minutes from now, or an ISO 8601 time with timezone.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What to remind the user about.' },
          minutes: { type: 'number', description: 'Minutes from now (1 to 10080).' },
          at: { type: 'string', description: 'ISO 8601 date and time, for example 2026-11-13T09:00:00-08:00.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      async run({ text, minutes, at }) {
        let dueAt = null;
        if (at !== undefined && at !== null && at !== '') {
          dueAt = at;
        } else if (minutes !== undefined && minutes !== null) {
          const m = Number(minutes);
          if (!Number.isFinite(m) || m < 1 || m > 10080) throw new Error('Minutes must be between 1 and 10080.');
          dueAt = new Date(clock().getTime() + m * 60_000).toISOString();
        } else {
          throw new Error('Give minutes or a time for the reminder.');
        }
        return { status: 'set', reminder: summarise(items.add({ kind: 'reminder', text, dueAt })) };
      },
    },
    {
      name: 'list_reminders',
      kind: 'immediate',
      description: 'List the reminders that have not fired yet.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        return { reminders: items.open('reminder').map(summarise) };
      },
    },
    {
      name: 'add_note',
      kind: 'immediate',
      description: 'Save a note or a to-do item for the user.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The note or to-do text.' } },
        required: ['text'],
        additionalProperties: false,
      },
      async run({ text }) {
        return { status: 'saved', note: summarise(items.add({ kind: 'note', text })) };
      },
    },
    {
      name: 'list_notes',
      kind: 'immediate',
      description: 'List the open notes and to-do items.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        return { notes: items.open('note').map(summarise) };
      },
    },
    {
      name: 'complete_item',
      kind: 'immediate',
      description: 'Mark a note or to-do item as done, using its id from list_notes.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The id of the note.' } },
        required: ['id'],
        additionalProperties: false,
      },
      async run({ id }) {
        const item = items.complete(String(id ?? ''));
        return { status: 'done', id: item.id };
      },
    },
  ];
}

function createToolRegistry({ getContacts, getTwilio, openExternal, items = null, clock = () => new Date() }) {
  /** Resolve a name or phone number to `{ phone, name }`. Throws a model-readable error when unresolvable. */
  function resolveRecipient(to) {
    const raw = String(to ?? '').trim();
    if (!raw) throw new Error('Recipient is missing. Give a contact name or a phone number.');
    const direct = normalizePhone(raw);
    if (direct) return { phone: direct, name: null };

    const needle = raw.toLowerCase();
    const contacts = getContacts();
    const exact = contacts.filter((c) => c.name.toLowerCase() === needle);
    const matches = exact.length ? exact : contacts.filter((c) => c.name.toLowerCase().includes(needle));
    if (matches.length === 1) {
      const phone = normalizePhone(matches[0].phone);
      if (!phone) throw new Error(`The saved number for ${matches[0].name} is not valid E.164. Fix it in Settings.`);
      return { phone, name: matches[0].name };
    }
    if (matches.length > 1) {
      throw new Error(`"${raw}" matches several contacts (${matches.map((c) => c.name).join(', ')}). Ask which one.`);
    }
    throw new Error(`No contact named "${raw}". Ask the user for a phone number in E.164 format, e.g. +15551234567.`);
  }

  const tools = [
    {
      name: 'get_time',
      kind: 'immediate',
      description: 'Get the current local date and time.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        const now = clock();
        return {
          iso: now.toISOString(),
          local: now.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' }),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        };
      },
    },
    {
      name: 'lookup_contact',
      kind: 'immediate',
      description: "Look up a saved contact's phone number by name.",
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Contact name to look up.' } },
        required: ['name'],
        additionalProperties: false,
      },
      async run({ name }) {
        const needle = String(name ?? '').trim().toLowerCase();
        const matches = getContacts().filter((c) => c.name.toLowerCase().includes(needle));
        return { matches: matches.map((c) => ({ name: c.name, phone: c.phone })) };
      },
    },
    {
      name: 'open_url',
      kind: 'immediate',
      description: 'Open an http or https web page in the user\'s default browser.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Full URL including https://' } },
        required: ['url'],
        additionalProperties: false,
      },
      async run({ url }) {
        let parsed;
        try {
          parsed = new URL(String(url));
        } catch {
          throw new Error('That is not a valid URL.');
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http and https links can be opened.');
        await openExternal(parsed.toString());
        return { opened: parsed.toString() };
      },
    },
    {
      name: 'send_text',
      kind: 'confirm',
      description:
        'Send an SMS text message to a contact or phone number. The user must confirm before it is sent. Only call this when the user asked to text someone.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Contact name or phone number in E.164 format.' },
          body: { type: 'string', description: 'The exact message text to send.' },
        },
        required: ['to', 'body'],
        additionalProperties: false,
      },
      prepare({ to, body }, deps) {
        const twilio = getTwilio();
        if (!twilio.isConfigured) throw new Error('Twilio is not configured yet, so texts cannot be sent. Tell the user to add Twilio details in Settings.');
        const text = String(body ?? '').trim();
        if (!text) throw new Error('Message body is empty.');
        if (text.length > MAX_SMS_LENGTH) throw new Error(`Message is too long (max ${MAX_SMS_LENGTH} characters).`);
        const recipient = resolveRecipient(to);
        const who = recipient.name ? `${recipient.name} (${recipient.phone})` : recipient.phone;
        return {
          summary: `Text ${who}: "${text}"`,
          execute: () => twilio.sendSms({ to: recipient.phone, body: text }),
        };
      },
    },
    {
      name: 'place_call',
      kind: 'confirm',
      description:
        'Place a phone call that reads a short spoken message to a contact or phone number. The user must confirm before the call is placed. Only call this when the user asked to call someone.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Contact name or phone number in E.164 format.' },
          message: { type: 'string', description: 'What the automated voice should say on the call.' },
        },
        required: ['to', 'message'],
        additionalProperties: false,
      },
      prepare({ to, message }) {
        const twilio = getTwilio();
        if (!twilio.isConfigured) throw new Error('Twilio is not configured yet, so calls cannot be placed. Tell the user to add Twilio details in Settings.');
        const text = String(message ?? '').trim();
        if (!text) throw new Error('Call message is empty.');
        if (text.length > MAX_CALL_MESSAGE_LENGTH) throw new Error(`Call message is too long (max ${MAX_CALL_MESSAGE_LENGTH} characters).`);
        const recipient = resolveRecipient(to);
        const who = recipient.name ? `${recipient.name} (${recipient.phone})` : recipient.phone;
        return {
          summary: `Call ${who} and say: "${text}"`,
          execute: () => twilio.placeCall({ to: recipient.phone, message: text }),
        };
      },
    },

    // Reminders and notes live on this PC. Only the items the model reads or writes go through it.
    ...(items ? itemTools(items, clock) : []),
  ];

  const byName = new Map(tools.map((t) => [t.name, t]));

  return {
    /** OpenAI-style function specs for the model. */
    specs() {
      return tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    },
    get(name) {
      return byName.get(name) ?? null;
    },
    names() {
      return tools.map((t) => t.name);
    },
    resolveRecipient,
  };
}

module.exports = { createToolRegistry };
