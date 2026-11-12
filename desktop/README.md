# Zer0 desktop companion (Windows)

A personal AI assistant that lives in a native Windows window and tray icon. Say **"Hey Zero"** to talk to it hands-free, or press the push-to-talk hotkey.

## What it does

- **Wake word.** Say "Hey Zero" followed by your request, or say "Hey Zero" and pause for a chime, then ask. Turn it on in Settings.
- **Chat and voice.** Type, or press `Ctrl+Shift+Space` and speak. Replies are read aloud.
- **Texts and calls.** Ask it to text or call a saved contact. Calls go through Twilio, and a spoken message is read on the call. Every text or call shows a confirmation card, and nothing is sent until you press Confirm.
- **Quick tools.** Tells the time, opens web pages, and looks up contacts.
- **Automatic updates.** Installed copies check GitHub Releases on launch and every four hours, download new versions in the background, and offer a one-click restart.
- **Tray app.** Closing the window hides it to the system tray, so Zer0 keeps listening. It can start when you sign in.

## Install (Windows)

1. Download `Zer0-Setup-<version>-x64.exe` from the [Releases page](https://github.com/Kvng0fd3ath/Zer0/releases) and run it. It installs per user, with no admin rights needed.
2. Open **Settings** (top right) and add:
   - an **NVIDIA API key** (`nvapi-...`, free at build.nvidia.com) as the **chat key**. It also powers speech-to-text and the wake word,
   - optionally a **Fish Audio API key** for natural spoken replies (otherwise Zer0 uses the Windows voice),
   - or an **OpenAI API key** instead, if you prefer OpenAI for chat and voice,
   - optionally a **Twilio** Account SID, Auth token and a From number you own (for texts and calls),
   - your **contacts**, one per line, as `Name, +15551234567`,
   - optionally, turn on **Listen for the wake phrase**.
3. Keys are encrypted with Windows DPAPI and are never shown back in the UI.

Environment variables work as a fallback: `LLM_API_KEY`, `OPENAI_API_KEY`, `FISH_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`.

**Which service does what**
- Speech to text (push-to-talk and the wake word): NVIDIA when your chat key is an `nvapi-` key, otherwise OpenAI. NVIDIA's model is English only.
- Spoken replies: Fish Audio if a Fish key is set, otherwise OpenAI if an OpenAI key is set, otherwise the Windows voice.
- An `nvapi-` key is only ever sent to NVIDIA.

### Windows checklist

- **Microphone access:** Windows Settings > Privacy & security > Microphone must allow desktop apps. Otherwise voice and the wake word stay silent.
- **SmartScreen:** unsigned builds show "Windows protected your PC" on first run. Click *More info* > *Run anyway*. Signing removes this (see below).
- **Start with Windows:** Settings > "Start when I sign in".

## How the wake word works

- Zer0 keeps the microphone open, but it only sends audio when it hears speech. A level meter watches the mic, and each short burst of speech is transcribed by NVIDIA (or OpenAI, if that is what is set up) and checked for the phrase.
- Silence and background noise never leave the PC. Speech bursts do, so turn the feature off if that is not acceptable.
- Listening pauses while Zer0 is busy or speaking, so it does not hear its own voice.
- Matching ignores case, punctuation, and "0" vs "o" (Whisper writes both as "Zero" or "Zer0"). Say the phrase in a normal voice; sensitivity can be raised for soft voices or lowered in noisy rooms.

## Development

```bash
cd desktop
npm ci
npm test          # 50 unit tests: settings, clients, tools, confirmations, agent loop, wake word, endpointing
npm start         # run from source (Windows, macOS or Linux)
npm run build:win # build the Windows installer into desktop/release/
```

Source layout:

| Path | Purpose |
| --- | --- |
| `src/core/` | Pure Node logic (no Electron): settings and secrets, model client, tools, confirmation queue, agent loop, Twilio and voice clients. |
| `src/main/` | Electron main process: window, tray, hotkey, IPC, Windows app identity, auto-updater. |
| `src/preload/` | Narrow, allowlisted bridge exposed to the page. |
| `src/renderer/` | The HUD (HTML, CSS, vanilla JS), the wake-word matcher, endpointing and the always-on mic listener. |
| `test/` | `node:test` suites. |

## Releasing and auto-updates

1. Bump `version` in `desktop/package.json`.
2. Tag and push: `git tag desktop-v0.2.0 && git push origin desktop-v0.2.0`.
3. The **Desktop release** workflow builds the Windows installer and publishes it to GitHub Releases, together with `latest.yml`, which the auto-updater reads.

To try a build before tagging, run the **Desktop CI** workflow manually; it uploads the installer as an artifact.

Notes:
- The auto-updater only runs in installed builds, not `npm start`.
- The repository must be public, or installed apps need a token to read releases.
- Code signing: add `CSC_LINK` and `CSC_KEY_PASSWORD` as repository secrets (a Windows code-signing certificate). Without it, updates still work but SmartScreen warns.
- Mac and Linux configuration remains in `package.json`, but the release and CI workflows build Windows only.

## Security notes

- Calls and texts always need an explicit confirmation in the UI. Pending confirmations expire after 10 minutes.
- Each confirmation card shows the exact recipient number and full message or call script. Contact names are resolved from your saved list only.
- The page cannot reach the network directly (`connect-src 'none'`). Only the main process calls the NVIDIA, OpenAI, Fish Audio and Twilio APIs.
- Only the microphone permission is granted, and only to this window.
- Conversation history is kept in memory and cleared when the app quits.
