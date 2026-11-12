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

/** Secrets are stored encrypted (via an injected codec) and never sent to the renderer. */
const SECRET_ENV_FALLBACK = Object.freeze({
  llmApiKey: 'LLM_API_KEY',
  openaiApiKey: 'OPENAI_API_KEY',
  twilioAccountSid: 'TWILIO_ACCOUNT_SID',
  twilioAuthToken: 'TWILIO_AUTH_TOKEN',
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

class ConfigStore {
  /**
   * @param {object} opts
   * @param {string} opts.dir Directory for settings.json and secrets.json (Electron userData in the app).
   * @param {{encrypt: (s: string) => string, decrypt: (s: string) => string}} [opts.codec]
   * @param {Record<string, string|undefined>} [opts.env]
   */
  constructor({ dir, codec = identityCodec, env = process.env }) {
    this.dir = dir;
    this.codec = codec;
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

  /** Returns the decrypted secret, falling back to an environment variable. */
  getSecret(name) {
    assertSecretName(name);
    const stored = this.#readSecrets()[name];
    if (typeof stored === 'string' && stored) {
      try {
        return this.codec.decrypt(stored);
      } catch {
        // Corrupt or unreadable secret: fall through to the environment.
      }
    }
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
  }

  /** What the renderer may see: settings plus booleans telling whether each secret is set. */
  publicView() {
    const secretsSet = {};
    for (const name of SECRET_NAMES) secretsSet[name] = Boolean(this.getSecret(name));
    return { settings: this.settings, secretsSet };
  }

  /** Resolved configuration for the agent, voice and Twilio clients. Never sent to the renderer. */
  runtime() {
    const s = this.settings;
    // Chat uses its own key (NVIDIA, OpenAI or another compatible provider). It falls back to the
    // OpenAI key so existing setups keep working. Voice and the wake word always use the OpenAI key.
    const llmKey = this.getSecret('llmApiKey') || this.getSecret('openaiApiKey');
    const voiceKey = this.getSecret('openaiApiKey');
    return {
      assistantName: s.assistantName,
      userName: s.userName,
      llm: { baseUrl: s.llm.baseUrl, model: s.llm.model, apiKey: llmKey },
      voice: { ...s.voice, apiKey: voiceKey },
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
  DEFAULT_SETTINGS,
  SECRET_NAMES,
  mergeKnown,
  sanitizeContacts,
  sanitizeWakeWord,
};
