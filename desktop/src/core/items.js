'use strict';

const crypto = require('node:crypto');
const { readJsonFile, writeJsonFile } = require('./secure_file');

const KINDS = Object.freeze(['reminder', 'note']);
const MAX_TEXT = 500;
const MAX_ITEMS = 500;

class ItemError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ItemError';
  }
}

/** Reminders and notes, kept on this PC. Done items stay until they are removed by a cap. */
class ItemStore {
  /**
   * @param {object} opts
   * @param {string} opts.file
   * @param {object} [opts.codec]  Optional codec for encryption at rest.
   * @param {() => Date} [opts.clock]
   */
  constructor({ file, codec, clock = () => new Date() }) {
    this.file = file;
    this.codec = codec;
    this.clock = clock;
    this.items = [];
  }

  async load() {
    const data = await readJsonFile(this.file, this.codec);
    this.items = Array.isArray(data) ? data.filter((x) => x && KINDS.includes(x.kind)).slice(-MAX_ITEMS) : [];
  }

  async save() {
    await writeJsonFile(this.file, this.items, this.codec);
  }

  /** Add a note, or a reminder with a due time (ISO string). */
  add({ kind, text, dueAt = null }) {
    if (!KINDS.includes(kind)) throw new ItemError('Unknown item type.');
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) throw new ItemError('Write something first.');
    if (clean.length > MAX_TEXT) throw new ItemError(`Keep it under ${MAX_TEXT} characters.`);
    let due = null;
    if (kind === 'reminder') {
      due = new Date(dueAt);
      if (Number.isNaN(due.getTime())) throw new ItemError('That reminder time is not valid.');
      if (due.getTime() <= this.clock().getTime()) throw new ItemError('That reminder time is in the past.');
    }
    const item = {
      id: crypto.randomUUID(),
      kind,
      text: clean,
      dueAt: due ? due.toISOString() : null,
      done: false,
      createdAt: this.clock().toISOString(),
    };
    this.items.push(item);
    if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS);
    return item;
  }

  /** Open (not done) items of a kind, reminders by due time and notes newest first. */
  open(kind) {
    const list = this.items.filter((x) => x.kind === kind && !x.done);
    if (kind === 'reminder') return list.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  complete(id) {
    const item = this.items.find((x) => x.id === id);
    if (!item) throw new ItemError('No item with that id.');
    item.done = true;
    return item;
  }

  /** Reminders that are due now. Marks them done so they fire once. */
  takeDue(now = this.clock()) {
    const due = this.items.filter((x) => x.kind === 'reminder' && !x.done && x.dueAt && new Date(x.dueAt) <= now);
    for (const r of due) r.done = true;
    return due;
  }
}

module.exports = { ItemStore, ItemError, KINDS, MAX_TEXT };
