'use strict';

/*
 * Wake-phrase matching. Pure logic, shared by the renderer (browser global) and the tests (CommonJS).
 *
 * Whisper often writes the name as "Zero" or "Zer0", and punctuation varies ("Hey, Zero!").
 * Each token of the phrase therefore matches case-insensitively, treating "o" and "0" as equal,
 * with any non-letter/digit run allowed between tokens.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Zer0WakeWord = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SEP = '[^a-z0-9]+';

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Build a RegExp that finds `phrase` as whole words in lowercased text. */
  function buildPattern(phrase) {
    const tokens = String(phrase ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    if (!tokens.length) return null;
    const body = tokens
      .map((t) => escapeRe(t).replace(/[o0]/g, '[o0]'))
      .join(SEP);
    return new RegExp(`(?:^|[^a-z0-9])${body}(?![a-z0-9])`);
  }

  /**
   * Returns { matched, command } where `command` is whatever was said after the wake phrase
   * (leading punctuation removed). `command` is empty when the user paused after the wake word.
   */
  function matchWake(transcript, phrase) {
    const text = String(transcript ?? '');
    const pattern = buildPattern(phrase);
    if (!pattern || !text.trim()) return { matched: false, command: '' };
    const m = pattern.exec(text.toLowerCase());
    if (!m) return { matched: false, command: '' };
    const rest = text.slice(m.index + m[0].length).replace(/^[\s,.:;!?-]+/, '').trim();
    return { matched: true, command: rest };
  }

  return { matchWake, buildPattern };
});
