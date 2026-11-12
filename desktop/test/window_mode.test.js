'use strict';

// Checks the full-window / small-ball switch in the main process, with a stubbed Electron.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

function loadMainWithStubs() {
  const handlers = {};
  const sent = [];
  const windows = [];
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
  let bounds = { x: 300, y: 120, width: 440, height: 740 };

  class BrowserWindow {
    constructor(opts) {
      this.opts = opts;
      this.calls = [];
      this.webContents = { send: (_ch, ev) => sent.push(ev), once() {}, on() {}, setWindowOpenHandler() {} };
      windows.push(this);
    }
    loadFile() {}
    once() {}
    on() {}
    isDestroyed() { return false; }
    isMinimized() { return false; }
    isVisible() { return true; }
    isFocused() { return true; }
    show() {}
    hide() {}
    focus() {}
    restore() {}
    minimize() {}
    setTitle() {}
    getBounds() { return { ...bounds }; }
    setBounds(b) { this.calls.push(['setBounds', b]); bounds = { ...bounds, ...b }; }
    setSize(width, height) { this.calls.push(['setSize', width, height]); bounds = { ...bounds, width, height }; }
    center() { this.calls.push(['center']); }
    setResizable(v) { this.calls.push(['setResizable', v]); }
    setMinimumSize(w, h) { this.calls.push(['setMinimumSize', w, h]); }
    setAlwaysOnTop(v) { this.calls.push(['setAlwaysOnTop', v]); }
  }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0-main-'));
  const stub = {
    app: {
      requestSingleInstanceLock: () => true, on() {}, whenReady: () => Promise.resolve(),
      getPath: () => userData, setAppUserModelId() {}, isPackaged: false, getVersion: () => '0.0.0-test', quit() {},
    },
    BrowserWindow,
    Tray: class { setToolTip() {} setContextMenu() {} on() {} },
    Menu: { buildFromTemplate: (t) => t },
    globalShortcut: { register: () => true, unregisterAll() {} },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    shell: { openExternal() {} },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true, resize() { return this; } }), createEmpty: () => ({}) },
    screen: { getDisplayMatching: () => ({ workArea }) },
  };

  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    return request === 'electron' ? stub : realLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../src/main/main.js')];
    require('../src/main/main.js');
  } finally {
    Module._load = realLoad;
  }
  return { handlers, sent, win: () => windows[0] };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

test('the window opens in full size with full minimum size', async () => {
  const { win } = loadMainWithStubs();
  await tick();
  assert.equal(win().opts.width, 440);
  assert.equal(win().opts.height, 740);
  assert.equal(win().opts.minWidth, 360);
  assert.equal(win().opts.minHeight, 520);
});

test('ball mode is a small always-on-top bar in the bottom-right corner', async () => {
  const { handlers, sent, win } = loadMainWithStubs();
  await tick();
  const res = await handlers['window:mode']({}, 'ball');
  assert.deepEqual(res, { ok: true, data: 'ball' });

  const w = win();
  const ball = w.calls.filter((c) => c[0] === 'setBounds').pop()[1];
  assert.equal(ball.width, 420);
  assert.equal(ball.height, 96);
  assert.equal(ball.x, 1920 - 420 - 24);
  assert.equal(ball.y, 1040 - 96 - 24);
  assert.ok(w.calls.some((c) => c[0] === 'setAlwaysOnTop' && c[1] === true));
  assert.ok(w.calls.some((c) => c[0] === 'setResizable' && c[1] === false));
  assert.ok(sent.some((e) => e.type === 'mode' && e.mode === 'ball'));
});

test('returning to the full window restores its last bounds', async () => {
  const { handlers, win } = loadMainWithStubs();
  await tick();
  await handlers['window:mode']({}, 'ball');
  const res = await handlers['window:mode']({}, 'full');
  assert.deepEqual(res, { ok: true, data: 'full' });

  const restore = win().calls.filter((c) => c[0] === 'setBounds').pop()[1];
  assert.equal(restore.x, 300);
  assert.equal(restore.y, 120);
  assert.equal(restore.width, 440);
  assert.equal(restore.height, 740);
  assert.ok(win().calls.some((c) => c[0] === 'setResizable' && c[1] === true));
});

test('requesting the current mode does nothing', async () => {
  const { handlers, win } = loadMainWithStubs();
  await tick();
  const before = win().calls.length;
  await handlers['window:mode']({}, 'full');
  assert.equal(win().calls.length, before);
});

test('unknown window modes are rejected', async () => {
  const { handlers } = loadMainWithStubs();
  await tick();
  const res = await handlers['window:mode']({}, 'sideways');
  assert.equal(res.ok, false);
  assert.match(res.error, /Unknown window mode/);
});
