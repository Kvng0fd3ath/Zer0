'use strict';

const { randomUUID } = require('node:crypto');

const PENDING_TTL_MS = 10 * 60_000;

/**
 * Holds side-effecting actions (texts, calls) until the user confirms or cancels them.
 */
class ActionQueue {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.items = new Map();
  }

  /** Queue an action. `execute` is only invoked by `confirm`. */
  add({ type, summary, execute }) {
    const action = { id: randomUUID(), type, summary, status: 'pending', createdAt: this.now(), result: null, error: null };
    this.items.set(action.id, { ...action, execute });
    return this.#view(action.id);
  }

  #view(id) {
    const item = this.items.get(id);
    if (!item) return null;
    const { execute, ...rest } = item;
    return rest;
  }

  #expire() {
    const cutoff = this.now() - PENDING_TTL_MS;
    for (const [id, item] of this.items) {
      if (item.status === 'pending' && item.createdAt < cutoff) {
        item.status = 'expired';
      }
    }
  }

  /** Pending actions only, newest last. */
  list() {
    this.#expire();
    return [...this.items.keys()].map((id) => this.#view(id)).filter((a) => a.status === 'pending');
  }

  get(id) {
    this.#expire();
    return this.#view(id);
  }

  cancel(id) {
    this.#expire();
    const item = this.items.get(id);
    if (!item) throw new Error('That action no longer exists.');
    if (item.status !== 'pending') throw new Error(`That action is already ${item.status}.`);
    item.status = 'cancelled';
    return this.#view(id);
  }

  async confirm(id) {
    this.#expire();
    const item = this.items.get(id);
    if (!item) throw new Error('That action no longer exists.');
    if (item.status !== 'pending') throw new Error(`That action is already ${item.status}.`);
    item.status = 'running';
    try {
      item.result = await item.execute();
      item.status = 'done';
    } catch (err) {
      item.error = err.message;
      item.status = 'failed';
    }
    return this.#view(id);
  }
}

module.exports = { ActionQueue, PENDING_TTL_MS };
