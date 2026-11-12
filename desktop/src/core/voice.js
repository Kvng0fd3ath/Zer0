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
async function transcribeAudio({ baseUrl, apiKey, model, audio, mimeType = 'audio/webm', prompt = '', fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new VoiceError('Voice input needs an OpenAI API key. Add one in Settings.');
  if (!audio || !audio.length) throw new VoiceError('No audio was recorded.');

  const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'm4a' : mimeType.includes('wav') ? 'wav' : 'webm';
  const form = new FormData();
  form.append('model', model);
  if (prompt) form.append('prompt', String(prompt).slice(0, 200));
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

/** NVIDIA hosted speech-to-text (Parakeet, English). Uses the same nvapi- key as chat. */
const NVIDIA_STT_URL = 'https://1598d209-5e27-4d3c-8079-4751568b1081.invocation.api.nvcf.nvidia.com/v1/audio/transcriptions';
/** Fish Audio text-to-speech. `s2.1-pro-free` is the free developer model. */
const FISH_TTS_URL = 'https://api.fish.audio/v1/tts';
const FISH_FREE_MODEL = 's2.1-pro-free';

function requireHttps(url) {
  if (!/^https:\/\//.test(url)) throw new VoiceError('Speech service address must start with https://');
  return url;
}

/**
 * Speech-to-text with NVIDIA. `wav` must be 16 kHz mono 16-bit WAV (the renderer converts recordings).
 * Returns the transcript string.
 */
async function transcribeWithNvidia({ url = NVIDIA_STT_URL, apiKey, language = 'en-US', wav, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new VoiceError('NVIDIA speech needs an NVIDIA key (nvapi-...). Add it as the chat key in Settings.');
  if (!wav || !wav.length) throw new VoiceError('No audio was recorded.');

  const form = new FormData();
  form.append('language', language);
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');

  const res = await fetchImpl(requireHttps(url), {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new VoiceError(data?.error?.message || data?.message || `NVIDIA speech failed (HTTP ${res.status}).`, { status: res.status });
  const text = data?.text ?? data?.transcript ?? data?.results?.[0]?.alternatives?.[0]?.transcript ?? '';
  return String(text).trim();
}

/** Text-to-speech with Fish Audio. Returns an MP3 Buffer. `voiceId` is optional (a Fish voice model ID). */
async function synthesizeWithFish({ apiKey, voiceId = '', text, model = FISH_FREE_MODEL, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new VoiceError('Fish Audio needs an API key. Add it in Settings.');
  const input = String(text ?? '').trim().slice(0, MAX_TTS_INPUT);
  if (!input) throw new VoiceError('Nothing to speak.');

  const body = { text: input, format: 'mp3', mp3_bitrate: 128, latency: 'normal' };
  if (voiceId) body.reference_id = String(voiceId);

  const res = await fetchImpl(FISH_TTS_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', model },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new VoiceError(data?.message || `Fish Audio speech failed (HTTP ${res.status}).`, { status: res.status });
  }
  return Buffer.from(await res.arrayBuffer());
}

module.exports = {
  transcribeAudio,
  synthesizeSpeech,
  transcribeWithNvidia,
  synthesizeWithFish,
  VoiceError,
  MAX_TTS_INPUT,
  NVIDIA_STT_URL,
  FISH_TTS_URL,
};
