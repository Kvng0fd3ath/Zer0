# Zer0 desktop companion

A Jarvis-style AI assistant that lives in a native desktop window and tray icon. It is not a terminal app.

## What it does

- **Chat and voice.** Type, or press the push-to-talk hotkey (default `Ctrl+Shift+Space` / `Cmd+Shift+Space`) and speak. Replies are read aloud.
- **Texts and calls.** Ask it to text or call a saved contact. Calls are placed through Twilio, and a spoken message is read on the call. Every text or call shows a confirmation card, and nothing is sent until you press Confirm.
- **Quick tools.** Tells the time, opens web pages, and looks up contacts.
- **Automatic updates.** Installed builds check GitHub Releases on launch and every four hours, download new versions in the background, and offer a one-click restart.
- **Starts with you.** Optional launch at sign-in, and it hides to the tray instead of quitting.

## Setup (for users)

1. Install a release from the [Releases page](https://github.com/Kvng0fd3ath/Zer0/releases).
2. Open **Settings** (top right) and add:
   - an **OpenAI API key** (chat and voice),
   - optionally a **Twilio** Account SID, Auth token and a From number you own (for texts and calls),
   - your **contacts**, one per line, as `Name, +15551234567`.
3. Keys are encrypted with your OS keychain (or by Electron's safe storage). They are never shown back in the UI.

Environment variables are also accepted as a fallback: `OPENAI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`.

## Development

```bash
cd desktop
npm ci
npm test          # unit tests for config, LLM/voice/Twilio clients, tools, confirmations, agent loop
npm start         # run the app from source
```

Source layout:

| Path | Purpose |
| --- | --- |
| `src/core/` | Pure Node logic (no Electron): settings and secrets, model client, tools, confirmation queue, agent loop, Twilio and voice clients. Covered by tests. |
| `src/main/` | Electron main process: window, tray, hotkey, IPC, auto-updater. |
| `src/preload/` | Narrow, allowlisted bridge exposed to the page. |
| `src/renderer/` | The HUD interface (HTML, CSS, vanilla JS). |
| `test/` | `node:test` suites. |

## Releasing and auto-updates

1. Bump `version` in `desktop/package.json`.
2. Tag and push: `git tag desktop-v0.2.0 && git push origin desktop-v0.2.0`.
3. The **Desktop release** workflow builds Windows (NSIS), macOS (DMG/ZIP) and Linux (AppImage) installers and publishes them to GitHub Releases, together with the `latest*.yml` metadata that `electron-updater` reads.

Notes:
- The auto-updater only runs in installed builds, not `npm start`.
- The repository must be public, or installed apps need a token to read releases.
- For smooth updates on Windows and macOS, sign the builds. Add `CSC_LINK` and `CSC_KEY_PASSWORD` as repository secrets. Unsigned builds still work, but the OS will warn on first launch, and macOS may block updates that are not signed.

## Security notes

- Calls and texts always need an explicit confirmation in the UI. Pending confirmations expire after 10 minutes.
- Each confirmation card shows the exact recipient number and full message or call script, so you can check them before pressing Confirm. Contact names are resolved from your saved list only.
- The page cannot reach the network directly (`connect-src 'none'`). Only the main process calls the OpenAI and Twilio APIs.
- Only the microphone permission is granted, and only to this window.
- Conversation history is kept in memory and cleared when the app quits.
