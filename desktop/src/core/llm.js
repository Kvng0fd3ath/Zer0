'use strict';

class LLMError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
  }
}

/**
 * Call an OpenAI-compatible Chat Completions endpoint.
 * Returns the assistant `message` object (may contain `tool_calls`).
 */
async function chatCompletion({
  baseUrl,
  apiKey,
  model,
  messages,
  tools,
  fetchImpl = globalThis.fetch,
  timeoutMs = 60_000,
}) {
  if (!apiKey) throw new LLMError('No OpenAI API key is set. Add one in Settings.');
  if (!baseUrl) throw new LLMError('No model endpoint is configured.');

  const body = { model, messages };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  // Accept either the base (".../v1") or the full endpoint (".../v1/chat/completions").
  const root = baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  const url = `${root}/chat/completions`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new LLMError(`Could not reach the model endpoint (${err.name === 'TimeoutError' ? 'timed out' : err.message}).`);
  }

  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  if (!res.ok) {
    const msg = data?.error?.message || `Model request failed with HTTP ${res.status}.`;
    throw new LLMError(msg, { status: res.status });
  }

  const message = data?.choices?.[0]?.message;
  if (!message) throw new LLMError('The model returned an empty response.');
  return message;
}

module.exports = { chatCompletion, LLMError };
