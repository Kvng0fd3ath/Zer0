'use strict';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * Automatic updates via electron-updater, which reads the `publish` config in package.json
 * (GitHub Releases for Kvng0fd3ath/Zer0). Updates only run in packaged builds.
 *
 * `notify(event)` receives { type, ... } objects that the renderer displays.
 */
function createUpdater({ app, notify, enabled }) {
  let autoUpdater = null;
  let timer = null;
  let state = { status: 'idle' };

  const emit = (next) => {
    state = { ...state, ...next };
    notify({ type: 'update-status', ...state });
  };

  function init() {
    if (!app.isPackaged) {
      emit({ status: 'disabled', reason: 'Updates are only active in installed builds.' });
      return;
    }
    if (!enabled) {
      emit({ status: 'disabled', reason: 'Automatic updates are turned off in Settings.' });
      return;
    }

    // Required lazily so development runs without the updater's native hooks.
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;

    autoUpdater.on('checking-for-update', () => emit({ status: 'checking' }));
    autoUpdater.on('update-not-available', () => emit({ status: 'up-to-date', version: app.getVersion() }));
    autoUpdater.on('update-available', (info) => emit({ status: 'downloading', version: info.version, percent: 0 }));
    autoUpdater.on('download-progress', (p) => emit({ status: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => emit({ status: 'ready', version: info.version }));
    autoUpdater.on('error', (err) => emit({ status: 'error', message: err?.message || String(err) }));

    check();
    timer = setInterval(check, CHECK_INTERVAL_MS);
    timer.unref?.();
  }

  function check() {
    if (!autoUpdater) return Promise.resolve(state);
    return autoUpdater.checkForUpdates().catch((err) => emit({ status: 'error', message: err.message }));
  }

  function installNow() {
    if (!autoUpdater || state.status !== 'ready') return false;
    autoUpdater.quitAndInstall(false, true);
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { init, check, installNow, stop, getState: () => state };
}

module.exports = { createUpdater, CHECK_INTERVAL_MS };
