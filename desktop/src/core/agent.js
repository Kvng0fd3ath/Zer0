'use strict';

const { chatCompletion } = require('./llm');

const MAX_TOOL_ROUNDS = 6;
const HISTORY_LIMIT = 30;

function systemPrompt({ assistantName, userName }, now) {
  const who = userName ? `The user's name is ${userName}.` : '';
  return [
    `You are ${assistantName}, a calm, capable, slightly witty AI companion that lives on the user's desktop.`,
    'Be concise and useful. Speak in plain sentences that sound natural when read aloud.',
    who,
    `The current local time is ${now.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })}.`,
    'You can look up contacts, open web pages, and check the time.',
    'To text or call someone, use the send_text or place_call tool. The user will see a confirmation card and must press Confirm before anything is sent, so say that you have queued it and are waiting for their confirmation.',
    'Never claim a text or call was sent unless you receive a confirmed result.',
    'Never invent phone numbers. If a contact is unknown, ask the user for the number.',
  ]
    .filter(Boolean)
    .join('\n');
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new Error('Tool arguments were not valid JSON.');
  }
}

class Companion {
  /**
   * @param {object} opts
   * @param {() => object} opts.getRuntime  Returns the resolved config (see ConfigStore.runtime()).
   * @param {ReturnType<import('./tools').createToolRegistry>} opts.tools
   * @param {import('./actions').ActionQueue} opts.queue
   * @param {typeof chatCompletion} [opts.chat]
   * @param {() => Date} [opts.clock]
   */
  constructor({ getRuntime, tools, queue, chat = chatCompletion, clock = () => new Date() }) {
    this.getRuntime = getRuntime;
    this.tools = tools;
    this.queue = queue;
    this.chat = chat;
    this.clock = clock;
    this.history = [];
  }

  /** Visible transcript for the UI: user and assistant text only. */
  transcript() {
    return this.history
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
      .map(({ role, content }) => ({ role, content }));
  }

  clear() {
    this.history = [];
  }

  #recentWindow() {
    let start = Math.max(0, this.history.length - HISTORY_LIMIT);
    // Never start the window on a tool result or an assistant tool call, which would orphan it.
    while (start < this.history.length && this.history[start].role !== 'user') start += 1;
    return this.history.slice(start);
  }

  async #runTool(call, newActions) {
    const name = call?.function?.name;
    const tool = this.tools.get(name);
    if (!tool) return { error: `Unknown tool "${name}".` };

    let args;
    try {
      args = parseArgs(call.function.arguments);
    } catch (err) {
      return { error: err.message };
    }

    try {
      if (tool.kind === 'immediate') {
        return await tool.run(args, {});
      }
      const prepared = tool.prepare(args, {});
      const action = this.queue.add({ type: name, summary: prepared.summary, execute: prepared.execute });
      newActions.push(action);
      return {
        status: 'awaiting_user_confirmation',
        actionId: action.id,
        summary: action.summary,
        note: 'Queued. Nothing has been sent yet. Tell the user it is waiting for their confirmation.',
      };
    } catch (err) {
      return { error: err.message };
    }
  }

  /**
   * Handle one user message. Returns `{ reply, actions }` where `actions` are newly queued
   * actions that need the user's confirmation.
   */
  async respond(userText) {
    const text = String(userText ?? '').trim();
    if (!text) throw new Error('Say something first.');

    const mark = this.history.length;
    this.history.push({ role: 'user', content: text });
    try {
      return await this.#respond();
    } catch (err) {
      // Roll back so the history never ends with an unanswered tool call.
      this.history.length = mark;
      throw err;
    }
  }

  async #respond() {
    const runtime = this.getRuntime();
    const newActions = [];
    const specs = this.tools.specs();

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const messages = [{ role: 'system', content: systemPrompt(runtime, this.clock()) }, ...this.#recentWindow()];
      const message = await this.chat({
        baseUrl: runtime.llm.baseUrl,
        apiKey: runtime.llm.apiKey,
        model: runtime.llm.model,
        messages,
        tools: specs,
      });

      const assistant = { role: 'assistant', content: message.content ?? '' };
      if (message.tool_calls?.length) assistant.tool_calls = message.tool_calls;
      this.history.push(assistant);

      if (!message.tool_calls?.length) {
        return { reply: String(message.content ?? '').trim(), actions: newActions };
      }

      for (const call of message.tool_calls) {
        const result = await this.#runTool(call, newActions);
        this.history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }

    const reply = 'I got tangled up trying to do that. Could you rephrase the request?';
    this.history.push({ role: 'assistant', content: reply });
    return { reply, actions: newActions };
  }

  /** Confirm a queued action, execute it, and tell the model the outcome. */
  async confirm(actionId) {
    const action = await this.queue.confirm(actionId);
    const outcome = action.status === 'done'
      ? `Confirmed and sent. Result: ${JSON.stringify(action.result ?? {})}`
      : `The action failed: ${action.error}`;
    this.history.push({ role: 'system', content: `User confirmed queued action "${action.summary}". ${outcome}` });
    return action;
  }

  cancel(actionId) {
    const action = this.queue.cancel(actionId);
    this.history.push({ role: 'system', content: `User cancelled queued action "${action.summary}". Nothing was sent.` });
    return action;
  }
}

module.exports = { Companion, systemPrompt, MAX_TOOL_ROUNDS };
