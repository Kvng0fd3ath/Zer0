'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Non-secret settings and their defaults. */
const DEFAULT_SETTINGS = Object.freeze({
  assistantName: 'Zer0',
  userName: '',
  llm: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  voice: {
    enabled: true,
    baseUrl: 'https://api.openai.com/v1',
    sttModel: 'gpt-4o-mini-transcribe',
    ttsModel: 'gpt-4o-mini-tts',
    ttsVoice: 'alloy',
    // NVIDIA speech-to-text (free with the chat key). Speech is English (en-US) for this model.
    nvidiaSttUrl: 'https://1598d209-5e27-4d3c-8079-4751568b1081.invocation.api.nvcf.nvidia.com/v1/audio/transcriptions',
    nvidiaSttLanguage: 'en-US',
    // Fish Audio voice model ID (optional). Blank uses Fish's default voice.
    fishVoiceId: '',
  },
  twilio: {
    fromNumber: '',
  },
  contacts: [],
  wakeWord: {
    enabled: false,
    phrase: 'Hey Zero',
    sensitivity: 'normal',
  },
  hotkey: 'CommandOrControl+Shift+Space',
  launchAtLogin: false,
  alwaysOnTop: true,
  autoUpdate: true,
});

/** NVIDIA keys start with nvapi-. They only ever go to NVIDIA's services. */
const isNvidiaKey = (key) => typeof key === 'string' && key.startsWith('nvapi-');

/** Secrets are stored encrypted (via an injected codec) and never sent to the renderer. */
const SECRET_ENV_FALLBACK = Object.freeze({
  llmApiKey: 'LLM_API_KEY',
  openaiApiKey: 'OPENAI_API_KEY',
  fishApiKey: 'FISH_API_KEY',
  twilioAccountSid: 'TWILIO_ACCOUNT_SID',
  twilioAuthToken: 'TWILIO_AUTH_TOKEN',
  // Email (read-only). Client IDs and secrets come from your own Google and Microsoft apps.
  gmailClientId: 'GMAIL_CLIENT_ID',
  gmailClientSecret: 'GMAIL_CLIENT_SECRET',
  outlookClientId: 'OUTLOOK_CLIENT_ID',
  // Refresh tokens are only written by the sign-in flow.
  gmailRefreshToken: null,
  outlookRefreshToken: null,
});

const SECRET_NAMES = Object.freeze(Object.keys(SECRET_ENV_FALLBACK));

const identityCodec = {
  encrypt: (plain) => plain,
  decrypt: (stored) => stored,
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep-merge `patch` into `base`, only accepting keys that already exist in `base`. */
function mergeKnown(base, patch) {
  if (!isPlainObject(patch)) return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const key of Object.keys(base)) {
    if (!(key in patch)) continue;
    const b = base[key];
    const p = patch[key];
    if (isPlainObject(b) && isPlainObject(p)) out[key] = mergeKnown(b, p);
    else if (typeof p === typeof b || (Array.isArray(b) && Array.isArray(p))) out[key] = p;
  }
  return out;
}

const WAKE_SENSITIVITIES = ['low', 'normal', 'high'];

/** Keep the wake-word settings in a safe, usable state. */
function sanitizeWakeWord(w) {
  const phrase = typeof w?.phrase === 'string' ? w.phrase.replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
  return {
    enabled: Boolean(w?.enabled),
    phrase: /\p{L}/u.test(phrase) ? phrase : DEFAULT_SETTINGS.wakeWord.phrase,
    sensitivity: WAKE_SENSITIVITIES.includes(w?.sensitivity) ? w.sensitivity : 'normal',
  };
}

/** Normalise a contacts list to `{ name, phone }` entries, dropping anything malformed. */
function sanitizeContacts(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => isPlainObject(c) && typeof c.name === 'string' && typeof c.phone === 'string')
    .map((c) => ({ name: c.name.trim().slice(0, 80), phone: c.phone.trim().slice(0, 32) }))
    .filter((c) => c.name && c.phone);
}

/**
 * Picks the speech services. Speech-to-text prefers NVIDIA (free with an nvapi- key), then OpenAI.
 * Speech output prefers Fish Audio, then OpenAI, then the Windows voice. An nvapi- key is never
 * used for OpenAI.
 */
function voiceEngines({ llmKey, openaiKey, fishKey, fishVoiceId }) {
  const openaiOk = Boolean(openaiKey) && !isNvidiaKey(openaiKey);
  const stt = isNvidiaKey(llmKey)
    ? { engine: 'nvidia', apiKey: llmKey }
    : openaiOk
      ? { engine: 'openai', apiKey: openaiKey }
      : { engine: 'none', apiKey: '' };
  const tts = fishKey
    ? { engine: 'fish', apiKey: fishKey, voiceId: String(fishVoiceId || '').trim() }
    : openaiOk
      ? { engine: 'openai', apiKey: openaiKey }
      : { engine: 'windows', apiKey: '' };
  return { stt, tts };
}

class ConfigStore {
  #secretCache; // name -> plaintext, filled by loadSecrets() or setSecret()
  #secretsLoaded;

  /**
   * @param {object} opts
   * @param {string} opts.dir Directory for settings.json and secrets.json (Electron userData in the app).
   * @param {{encrypt: (s: string) => string, decrypt: (s: string) => string}} [opts.codec]
   * @param {Record<string, string|undefined>} [opts.env]
   */
  constructor({ dir, codec = identityCodec, env = process.env }) {
    this.dir = dir;
    this.codec = codec;
    this.#secretCache = new Map();
    this.#secretsLoaded = false;
    this.env = env;
    this.settingsPath = path.join(dir, 'settings.json');
    this.secretsPath = path.join(dir, 'secrets.json');
    this.settings = this.#readSettings();
  }

  #readSettings() {
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
    } catch {
      raw = {};
    }
    const merged = mergeKnown(DEFAULT_SETTINGS, raw);
    merged.contacts = sanitizeContacts(merged.contacts);
    merged.wakeWord = sanitizeWakeWord(merged.wakeWord);
    return merged;
  }

  #writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  /** Apply a partial settings update. Secrets are not accepted here. */
  updateSettings(patch) {
    const next = mergeKnown(this.settings, patch);
    next.contacts = sanitizeContacts(next.contacts);
    next.wakeWord = sanitizeWakeWord(next.wakeWord);
    this.settings = next;
    this.#writeJson(this.settingsPath, next);
    return this.settings;
  }

  #readSecrets() {
    try {
      return JSON.parse(fs.readFileSync(this.secretsPath, 'utf8'));
    } catch {
      return {};
    }
  }

  /**
   * Decrypt every saved secret once, asynchronously, and keep the plaintext in memory.
   * The app calls this at startup, before anything reads a secret. Once loaded,
   * getSecret() never touches the codec again.
   */
  async loadSecrets() {
    const all = this.#readSecrets();
    for (const name of SECRET_NAMES) {
      const stored = all[name];
      if (typeof stored !== 'string' || !stored) continue;
      try {
        const plain = this.codec.decryptAsync ? await this.codec.decryptAsync(stored) : this.codec.decrypt(stored);
        this.#secretCache.set(name, plain);
      } catch {
        // Unreadable secret: getSecret() falls back to the environment.
      }
    }
    this.#secretsLoaded = true;
  }

  /** Like setSecret(), but uses the codec's async encryption when it has one. */
  async setSecretAsync(name, value) {
    assertSecretName(name);
    const plain = value ? String(value).trim() : '';
    const all = this.#readSecrets();
    if (!plain) {
      delete all[name];
    } else {
      all[name] = this.codec.encryptAsync ? await this.codec.encryptAsync(plain) : this.codec.encrypt(plain);
    }
    this.#writeJson(this.secretsPath, all);
    this.#cacheSecret(name, plain);
  }

  #cacheSecret(name, plain) {
    if (plain) this.#secretCache.set(name, plain);
    else this.#secretCache.delete(name);
  }

  /** Returns the decrypted secret, falling back to an environment variable. */
  getSecret(name) {
    assertSecretName(name);
    if (this.#secretsLoaded) {
      return this.#secretCache.get(name) || this.#envSecret(name);
    }
    const stored = this.#readSecrets()[name];
    if (typeof stored === 'string' && stored) {
      try {
        return this.codec.decrypt(stored);
      } catch {
        // Corrupt or unreadable secret: fall through to the environment.
      }
    }
    return this.#envSecret(name);
  }

  #envSecret(name) {
    const envName = SECRET_ENV_FALLBACK[name];
    return (envName && this.env[envName]) || '';
  }

  /** Store a secret (encrypted). An empty value removes it. */
  setSecret(name, value) {
    assertSecretName(name);
    const all = this.#readSecrets();
    if (!value) {
      delete all[name];
    } else {
      all[name] = this.codec.encrypt(String(value).trim());
    }
    this.#writeJson(this.secretsPath, all);
    this.#cacheSecret(name, value ? String(value).trim() : '');
  }

  /** What the renderer may see: settings plus booleans telling whether each secret is set. */
  publicView() {
    const secretsSet = {};
    for (const name of SECRET_NAMES) secretsSet[name] = Boolean(this.getSecret(name));
    const { voice } = this.runtime();
    // Engine names only, never keys.
    const voiceEnginesView = { stt: voice.stt.engine, tts: voice.tts.engine };
    return { settings: this.settings, secretsSet, voiceEngines: voiceEnginesView };
  }

  /** Resolved configuration for the agent, voice and Twilio clients. Never sent to the renderer. */
  runtime() {
    const s = this.settings;
    // Chat uses its own key (NVIDIA, OpenAI or another compatible provider). It falls back to the
    // OpenAI key so existing setups keep working. Speech services are chosen in voiceEngines().
    const llmKey = this.getSecret('llmApiKey') || this.getSecret('openaiApiKey');
    const openaiKey = this.getSecret('openaiApiKey');
    const fishKey = this.getSecret('fishApiKey');
    return {
      assistantName: s.assistantName,
      userName: s.userName,
      llm: { baseUrl: s.llm.baseUrl, model: s.llm.model, apiKey: llmKey },
      voice: { ...s.voice, ...voiceEngines({ llmKey, openaiKey, fishKey, fishVoiceId: s.voice.fishVoiceId }) },
      twilio: {
        accountSid: this.getSecret('twilioAccountSid'),
        authToken: this.getSecret('twilioAuthToken'),
        fromNumber: s.twilio.fromNumber || this.env.TWILIO_FROM_NUMBER || '',
      },
      contacts: s.contacts,
    };
  }
}

function assertSecretName(name) {
  if (!SECRET_NAMES.includes(name)) throw new Error(`Unknown secret: ${name}`);
}

module.exports = {
  ConfigStore,
  voiceEngines,
  isNvidiaKey,
  DEFAULT_SETTINGS,
  SECRET_NAMES,
  mergeKnown,
  sanitizeContacts,
  sanitizeWakeWord,
};
