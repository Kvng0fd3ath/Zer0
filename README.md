# Zer0

Zer0 is a Jarvis-style AI desktop companion for Windows. It runs as a native window with a tray icon, not in a terminal. Say "Hey Zero" or type, it reads its replies aloud, and it can text or call your contacts (after you confirm each one). It updates itself automatically.

- **App source and docs:** [`desktop/`](desktop/README.md)
- **Install:** download `Zer0-Setup-<version>-x64.exe` from [Releases](https://github.com/Kvng0fd3ath/Zer0/releases) once a release is published.
- **Release:** bump `desktop/package.json`, then push a tag such as `desktop-v0.2.0`. CI builds the Windows installer and publishes it, and installed copies pick up the update.
