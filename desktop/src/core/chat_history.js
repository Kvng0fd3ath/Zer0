'use strict';

const { readJsonFile, writeJsonFile } = require('./secure_file');

const MAX_MESSAGES = 200;

/** Saves the visible chat (user and assistant text) between app sessions. */
class ChatHistory {
  constructor({ file, codec }) {
    this.file = file;
    this.codec = codec;
  }

  async load() {
    const data = await readJsonFile(this.file, this.codec);
    if (!Array.isArray(data)) return [];
    return data
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
      .slice(-MAX_MESSAGES);
  }

  async save(messages) {
    const clean = (Array.isArray(messages) ? messages : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-MAX_MESSAGES)
      .map(({ role, content }) => ({ role, content }));
    await writeJsonFile(this.file, clean, this.codec);
  }
}

module.exports = { ChatHistory, MAX_MESSAGES };
