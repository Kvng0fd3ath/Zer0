'use strict';

const MAX_TTS_INPUT = 4000;

class VoiceError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'VoiceError';
    this.status = status;
  }
}

function baseOf(url) {
  return String(url || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

/** Speech-to-text. `audio` is a Buffer/Uint8Array of recorded audio. Returns the transcript string. */
async function transcribeAudio({ baseUrl, apiKey, model, audio, mimeType = 'audio/webm', fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new VoiceError('Voice input needs an OpenAI API key. Add one in Settings.');
  if (!audio || !audio.length) throw new VoiceError('No audio was recorded.');

  const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'm4a' : mimeType.includes('wav') ? 'wav' : 'webm';
  const form = new FormData();
  form.append('model', model);
  form.append('file', new Blob([audio], { type: mimeType }), `speech.${ext}`);

  const res = await fetchImpl(`${baseOf(baseUrl)}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new VoiceError(data?.error?.message || `Transcription failed (HTTP ${res.status}).`, { status: res.status });
  return String(data?.text ?? '').trim();
}

/** Text-to-speech. Returns an MP3 Buffer. */
async function synthesizeSpeech({ baseUrl, apiKey, model, voice, text, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new VoiceError('Voice output needs an OpenAI API key. Add one in Settings.');
  const input = String(text ?? '').trim().slice(0, MAX_TTS_INPUT);
  if (!input) throw new VoiceError('Nothing to speak.');

  const res = await fetchImpl(`${baseOf(baseUrl)}/audio/speech`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, voice, input, response_format: 'mp3' }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new VoiceError(data?.error?.message || `Speech synthesis failed (HTTP ${res.status}).`, { status: res.status });
  }
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { transcribeAudio, synthesizeSpeech, VoiceError, MAX_TTS_INPUT };
