'use strict';

// Converts recorded audio (WebM/Opus from MediaRecorder) into 16 kHz mono 16-bit WAV for NVIDIA speech.
(() => {
  /** Encode mono float samples (-1..1) as a 16-bit PCM WAV file. Returns an ArrayBuffer. */
  function encodeWav16(samples, sampleRate) {
    const dataBytes = samples.length * 2;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buffer);
    const writeText = (offset, text) => {
      for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
    };

    writeText(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true); // PCM fmt chunk size
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    writeText(36, 'data');
    view.setUint32(40, dataBytes, true);

    for (let i = 0; i < samples.length; i += 1) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
  }

  /** Decode a recording and resample it to 16 kHz mono WAV. */
  async function toWav16kMono(blob, { targetRate = 16000 } = {}) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const decodeCtx = new Ctx();
    let decoded;
    try {
      decoded = await decodeCtx.decodeAudioData(await blob.arrayBuffer());
    } finally {
      decodeCtx.close?.();
    }

    const frames = Math.max(1, Math.ceil(decoded.duration * targetRate));
    const offline = new Offline(1, frames, targetRate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return new Blob([encodeWav16(rendered.getChannelData(0), targetRate)], { type: 'audio/wav' });
  }

  window.Zer0Wav = { encodeWav16, toWav16kMono };
})();
