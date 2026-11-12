'use strict';

/*
 * Always-on microphone listener for the wake phrase.
 *
 * Audio never leaves the device unless speech is detected: a level meter watches the mic, and only
 * when someone speaks is a short clip recorded and handed to `onUtterance` (which transcribes it
 * and checks for the wake phrase). Listening pauses while the assistant is busy or speaking.
 */
(function (root) {
  const Endpointer = root.Zer0Endpointer;

  // RMS thresholds on a 0..1 scale. Lower = more sensitive (picks up quieter speech).
  const SENSITIVITY = { low: 0.04, normal: 0.022, high: 0.012 };

  function pickMimeType() {
    const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    return options.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  }

  /** Short two-tone chime, generated locally so it costs nothing and needs no audio file. */
  function playChime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [660, 990].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.09);
        gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + i * 0.09 + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.09 + 0.08);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + i * 0.09);
        osc.stop(ctx.currentTime + i * 0.09 + 0.09);
      });
      setTimeout(() => ctx.close().catch(() => {}), 400);
    } catch {
      // Audio feedback is optional.
    }
  }

  /**
   * @param {object} opts
   * @param {(blob: Blob) => void} opts.onUtterance  Called with each recorded utterance.
   * @param {() => boolean} opts.isPaused            True while the assistant is busy or speaking.
   * @param {(state: 'off'|'listening', error?: string) => void} [opts.onState]
   */
  function createWakeListener({ onUtterance, isPaused, onState = () => {} }) {
    let stream = null;
    let ctx = null;
    let analyser = null;
    let buffer = null;
    let timer = null;
    let recorder = null;
    let endpointer = null;
    let running = false;

    function onSpeechStart() {
      if (recorder || !stream) return;
      const chunks = [];
      const mimeType = pickMimeType();
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        if (rec.__valid && blob.size > 1000) onUtterance(blob);
      };
      rec.__valid = false;
      rec.start(250);
      recorder = rec;
    }

    function onSpeechEnd({ valid }) {
      const rec = recorder;
      if (!rec) return;
      recorder = null;
      rec.__valid = valid;
      if (rec.state !== 'inactive') rec.stop();
    }

    function tick() {
      if (!analyser) return;
      if (isPaused()) {
        endpointer.reset();
        return;
      }
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i];
      endpointer.feed(Math.sqrt(sum / buffer.length), performance.now());
    }

    async function start({ sensitivity = 'normal' } = {}) {
      if (running) return;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (err) {
        onState('off', `Microphone unavailable: ${err.message}`);
        return;
      }
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      buffer = new Float32Array(analyser.fftSize);

      endpointer = Endpointer.createEndpointer({
        threshold: SENSITIVITY[sensitivity] ?? SENSITIVITY.normal,
        onStart: onSpeechStart,
        onEnd: onSpeechEnd,
      });
      timer = setInterval(tick, 50);
      running = true;
      onState('listening');
    }

    function stop() {
      if (!running) return;
      running = false;
      clearInterval(timer);
      timer = null;
      if (endpointer) endpointer.reset();
      if (recorder) onSpeechEnd({ valid: false });
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close().catch(() => {});
      stream = null;
      ctx = null;
      analyser = null;
      onState('off');
    }

    return { start, stop, get running() { return running; } };
  }

  root.Zer0WakeListener = { createWakeListener, playChime, SENSITIVITY };
})(typeof globalThis !== 'undefined' ? globalThis : window);
