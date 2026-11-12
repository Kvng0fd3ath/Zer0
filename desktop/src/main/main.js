'use strict';

const path = require('node:path');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  shell,
  safeStorage,
  session,
  nativeImage,
  screen,
} = require('electron');

const { ConfigStore, SECRET_NAMES } = require('../core/config');
const { Companion } = require('../core/agent');
const { createToolRegistry } = require('../core/tools');
const { ActionQueue } = require('../core/actions');
const { TwilioClient } = require('../core/twilio');
const { transcribeAudio, synthesizeSpeech, transcribeWithNvidia, synthesizeWithFish } = require('../core/voice');
const { createUpdater } = require('./updater');

const ROOT = path.join(__dirname, '..', '..');
const ICON = path.join(ROOT, 'assets', 'icon.png');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const INDEX = path.join(__dirname, '..', 'renderer', 'index.html');

// Full window (the main app) and the small ball (a compact bar that keeps the chat prompt).
const MODES = {
  full: { width: 440, height: 740, minWidth: 360, minHeight: 520, resizable: true },
  ball: { width: 420, height: 96, minWidth: 420, minHeight: 96, resizable: false },
};

let win = null;
let tray = null;
let quitting = false;
let store;
let companion;
let queue;
let updater;
let mode = 'full';
let fullBounds = null; // remembered so returning from the ball restores the window

/** Secrets are encrypted with the OS keychain when available; otherwise stored with a marker. */
const codec = {
  encrypt(plain) {
    if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(plain).toString('base64')}`;
    return `plain:${plain}`;
  },
  decrypt(stored) {
    if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    if (stored.startsWith('plain:')) return stored.slice(6);
    throw new Error('Unknown secret format');
  },
};

function send(event) {
  if (win && !win.isDestroyed()) win.webContents.send('zer0:event', event);
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

/** Switches between the full window and the small ball. Returns the mode now in use. */
function applyMode(next) {
  if (!win || win.isDestroyed() || !MODES[next] || next === mode) return mode;
  const cfg = MODES[next];

  if (mode === 'full') fullBounds = win.getBounds();
  win.setResizable(true);
  win.setMinimumSize(cfg.minWidth, cfg.minHeight);

  if (next === 'ball') {
    // Park the ball in the bottom-right corner of the screen it is on, above other windows.
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    win.setBounds({
      width: cfg.width,
      height: cfg.height,
      x: area.x + area.width - cfg.width - 24,
      y: area.y + area.height - cfg.height - 24,
    });
    win.setAlwaysOnTop(true);
  } else {
    if (fullBounds) win.setBounds(fullBounds);
    else {
      win.setSize(cfg.width, cfg.height);
      win.center();
    }
    win.setAlwaysOnTop(Boolean(store.settings.alwaysOnTop));
  }
  win.setResizable(cfg.resizable);

  mode = next;
  send({ type: 'mode', mode });
  return mode;
}

function createWindow() {
  win = new BrowserWindow({
    ...MODES.full,
    title: store.settings.assistantName,
    icon: ICON,
    frame: false,
    backgroundColor: '#05080d',
    alwaysOnTop: store.settings.alwaysOnTop,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Keep the wake-word listener running at full speed while the window is hidden in the tray.
      backgroundThrottling: false,
    },
  });

  win.loadFile(INDEX);
  win.once('ready-to-show', () => showWindow());

  // The window only ever shows our own page.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing hides to the tray so the companion stays available.
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 32, height: 32 }));
  tray.setToolTip(store.settings.assistantName);
  const menu = Menu.buildFromTemplate([
    { label: 'Show Zer0', click: showWindow },
    { label: 'Show as small ball', click: () => { applyMode('ball'); showWindow(); } },
    { label: 'Show full window', click: () => { applyMode('full'); showWindow(); } },
    { label: 'Push to talk (hotkey)', click: () => { showWindow(); send({ type: 'push-to-talk' }); } },
    { type: 'separator' },
    { label: 'Check for updates', click: () => updater.check() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', toggleWindow);
}

function registerHotkey(accelerator) {
  globalShortcut.unregisterAll();
  if (!accelerator) return { ok: true };
  try {
    const ok = globalShortcut.register(accelerator, () => {
      showWindow();
      send({ type: 'push-to-talk' });
    });
    return ok ? { ok: true } : { ok: false, message: 'That shortcut is in use by another app.' };
  } catch (err) {
    return { ok: false, message: `Invalid shortcut: ${err.message}` };
  }
}

function applyLoginItem(enabled) {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: true });
}

function publicState() {
  return { ...store.publicView(), version: app.getVersion(), packaged: app.isPackaged, update: updater.getState() };
}

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message || 'Something went wrong.' };
    }
  });

  handle('state:get', () => publicState());

  handle('settings:update', (patch) => {
    if (!patch || typeof patch !== 'object') throw new Error('Invalid settings.');
    store.updateSettings(patch);
    if (patch.hotkey !== undefined) {
      const res = registerHotkey(store.settings.hotkey);
      if (!res.ok) throw new Error(res.message);
    }
    if (patch.launchAtLogin !== undefined) applyLoginItem(store.settings.launchAtLogin);
    if (patch.alwaysOnTop !== undefined && win && mode === 'full') win.setAlwaysOnTop(Boolean(store.settings.alwaysOnTop));
    if (patch.assistantName !== undefined && win) win.setTitle(store.settings.assistantName);
    return publicState();
  });

  handle('secrets:set', ({ name, value } = {}) => {
    if (!SECRET_NAMES.includes(name)) throw new Error('Unknown setting.');
    store.setSecret(name, typeof value === 'string' ? value : '');
    return publicState();
  });

  handle('chat:send', async (text) => {
    if (typeof text !== 'string') throw new Error('Invalid message.');
    const { reply, actions } = await companion.respond(text);
    return { reply, actions };
  });

  handle('chat:transcript', () => companion.transcript());

  handle('chat:clear', () => {
    companion.clear();
    return true;
  });

  handle('actions:confirm', async (id) => companion.confirm(String(id)));
  handle('actions:cancel', (id) => companion.cancel(String(id)));
  handle('actions:list', () => queue.list());

  handle('voice:transcribe', async (bytes, mimeType, prompt) => {
    const rt = store.runtime();
    const audio = Buffer.from(bytes);
    if (audio.length > 25 * 1024 * 1024) throw new Error('Recording is too long.');
    const type = typeof mimeType === 'string' ? mimeType : 'audio/webm';
    const stt = rt.voice.stt;
    if (stt.engine === 'nvidia') {
      // NVIDIA takes 16 kHz mono WAV; the renderer converts each recording before sending.
      if (type !== 'audio/wav') throw new Error('Could not prepare the recording for NVIDIA speech.');
      return transcribeWithNvidia({ url: rt.voice.nvidiaSttUrl, apiKey: stt.apiKey, language: rt.voice.nvidiaSttLanguage, wav: audio });
    }
    if (stt.engine === 'openai') {
      return transcribeAudio({
        baseUrl: rt.voice.baseUrl,
        apiKey: stt.apiKey,
        model: rt.voice.sttModel,
        audio,
        mimeType: type,
        prompt: typeof prompt === 'string' ? prompt : '',
      });
    }
    throw new Error('Voice input needs an NVIDIA key or an OpenAI key. Add one in Settings.');
  });

  handle('voice:speak', async (text) => {
    const rt = store.runtime();
    const tts = rt.voice.tts;
    if (!rt.voice.enabled || tts.engine === 'windows') return null;
    const input = String(text ?? '');
    const mp3 = tts.engine === 'fish'
      ? await synthesizeWithFish({ apiKey: tts.apiKey, voiceId: tts.voiceId, text: input })
      : await synthesizeSpeech({
        baseUrl: rt.voice.baseUrl,
        apiKey: tts.apiKey,
        model: rt.voice.ttsModel,
        voice: rt.voice.ttsVoice,
        text: input,
      });
    return new Uint8Array(mp3);
  });

  handle('updates:check', () => updater.check().then(() => updater.getState()));
  handle('updates:install', () => {
    if (!updater.installNow()) throw new Error('No update is ready to install yet.');
    return true;
  });

  handle('window:mode', (next) => {
    if (next !== 'full' && next !== 'ball') throw new Error('Unknown window mode.');
    return applyMode(next);
  });
  handle('window:hide', () => { win?.hide(); return true; });
  handle('window:minimize', () => { win?.minimize(); return true; });
  handle('window:quit', () => { app.quit(); return true; });
}

function configureSessionSecurity() {
  // Only the microphone is granted, and only to our own window.
  const allow = (permission) => permission === 'media';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allow(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allow(permission));
}

function buildServices() {
  store = new ConfigStore({ dir: app.getPath('userData'), codec });
  queue = new ActionQueue();

  const getTwilio = () => {
    const t = store.runtime().twilio;
    return new TwilioClient({ accountSid: t.accountSid, authToken: t.authToken, fromNumber: t.fromNumber });
  };

  const tools = createToolRegistry({
    getContacts: () => store.settings.contacts,
    getTwilio,
    openExternal: (url) => shell.openExternal(url),
  });

  companion = new Companion({
    getRuntime: () => store.runtime(),
    tools,
    queue,
  });
}

function start() {
  // Windows groups taskbar buttons, notifications and the installer shortcut by this ID.
  if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'com.kvng0fd3ath.zer0' : process.execPath);
  buildServices();
  configureSessionSecurity();
  registerIpc();
  createWindow();
  createTray();

  const hotkey = registerHotkey(store.settings.hotkey);
  if (!hotkey.ok) send({ type: 'notice', level: 'warn', message: hotkey.message });

  applyLoginItem(store.settings.launchAtLogin);

  updater = createUpdater({
    app,
    enabled: store.settings.autoUpdate,
    notify: (event) => send(event),
  });
  win.webContents.once('did-finish-load', () => updater.init());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(start);

  app.on('before-quit', () => {
    quitting = true;
    updater?.stop();
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());

  // Closing the window hides it to the tray (see createWindow), so the app keeps running.

  app.on('activate', showWindow);
}
