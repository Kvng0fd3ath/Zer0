'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Only these channels may be invoked from the page.
const INVOKE_CHANNELS = [
  'state:get',
  'settings:update',
  'secrets:set',
  'chat:send',
  'chat:transcript',
  'chat:clear',
  'actions:confirm',
  'actions:cancel',
  'actions:list',
  'voice:transcribe',
  'voice:speak',
  'updates:check',
  'updates:install',
  'window:hide',
  'window:minimize',
  'window:quit',
];

/** Call a main-process handler. Resolves with data or throws an Error with the user-facing message. */
async function invoke(channel, ...args) {
  if (!INVOKE_CHANNELS.includes(channel)) throw new Error(`Blocked channel: ${channel}`);
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

contextBridge.exposeInMainWorld('zer0', {
  invoke,
  /** Subscribe to main-process events (updates, push-to-talk, notices). Returns an unsubscribe function. */
  onEvent(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('zer0:event', listener);
    return () => ipcRenderer.removeListener('zer0:event', listener);
  },
});
