'use strict';

/*
 * Speech endpointing from a stream of audio levels (RMS). Pure logic so it can be unit tested.
 *
 *   feed(level, nowMs) is called ~20 times a second.
 *   onStart()          fires once speech has lasted `onsetMs` (filters out clicks).
 *   onEnd({ valid })   fires after `silenceMs` of quiet, or at `maxMs`. `valid` is false when the
 *                      utterance was shorter than `minSpeechMs`, so it should be discarded.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Zer0Endpointer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createEndpointer({
    threshold,
    onsetMs = 120,
    minSpeechMs = 300,
    silenceMs = 900,
    maxMs = 15_000,
    onStart = () => {},
    onEnd = () => {},
  }) {
    let candidateAt = null; // when the current loud run began, before onset is confirmed
    let speaking = false;
    let startedAt = 0;
    let lastVoiceAt = 0;

    function finish(valid) {
      speaking = false;
      candidateAt = null;
      onEnd({ valid, durationMs: Math.max(0, lastVoiceAt - startedAt) });
    }

    return {
      get speaking() {
        return speaking;
      },

      feed(level, now) {
        const loud = level >= threshold;
        if (!speaking) {
          if (!loud) {
            candidateAt = null;
            return;
          }
          if (candidateAt === null) candidateAt = now;
          if (now - candidateAt >= onsetMs) {
            speaking = true;
            startedAt = candidateAt;
            lastVoiceAt = now;
            onStart({ at: startedAt });
          }
          return;
        }

        if (loud) lastVoiceAt = now;
        const quietFor = now - lastVoiceAt;
        const tooLong = now - startedAt >= maxMs;
        if (quietFor >= silenceMs || tooLong) {
          finish(lastVoiceAt - startedAt >= minSpeechMs);
        }
      },

      /** Abort any utterance in progress (e.g. when the assistant starts talking). */
      reset() {
        if (speaking) finish(false);
        candidateAt = null;
      },
    };
  }

  return { createEndpointer };
});
