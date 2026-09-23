# MeetingScribe

Cross-platform desktop app (Windows + macOS, built with Electron) for recording
audio and getting it transcribed by a REST backend.

**Phase 1 scope:** voice transcription only — record from the microphone or
import an existing audio file, upload it, poll for the transcript, and keep a
local, offline-readable history.

## Features

| Screen | What it does |
| --- | --- |
| **Record** | Big record/stop button with a live timer and level meter. On stop, audio is saved locally as a 16 kHz mono 16-bit PCM `.wav`, then the upload → transcribe flow starts automatically. `Import Audio File` opens a native picker (`.wav`, `.mp3`, `.m4a`) and runs the same flow. Drag-and-drop onto the panel also works. A status card shows **Uploading → Transcribing → Done** (or an error with a Retry button). |
| **History** | Every recording/import with date, duration, source (Recorded / Imported) and status. Click one to read the transcript. **Copy** to clipboard, **Export .txt**, Show file, Delete, and Retry for failed jobs. Works offline for stored transcripts. |
| **Settings** | Backend API base URL (e.g. `http://<ec2-ip>:8000`), persisted between launches, plus a "Test connection" button. |

## Backend contract

The app is a client for this REST API (base URL configurable in Settings):

```
POST {base}/upload-url        { "filename": "recording.wav" }
                              -> { "upload_url": "<presigned S3 URL>", "s3_key": "<key>" }
PUT  {upload_url}             raw audio bytes (no auth headers)
POST {base}/transcribe        { "s3_key": "<key>" }   -> { "job_id": "<uuid>" }
GET  {base}/status/{job_id}   -> { "job_id", "status": "processing"|"done"|"error",
                                   "transcript"?, "error"? }
```

`/status` is polled every 3 seconds until `done` or `error`. Transient poll
failures are tolerated (up to 5 in a row) before the job is marked failed.

## Getting started

```bash
npm install
npm start            # launch the app
```

### Run against the bundled mock backend

No real backend handy? A tiny mock server implements the full contract:

```bash
npm run mock-backend            # http://127.0.0.1:8000, jobs finish after ~4 s
# MOCK_DELAY_MS=10000 npm run mock-backend   -> slower jobs
# MOCK_FAIL=1 npm run mock-backend           -> every job ends in status "error"
```

Then set the API base URL in **Settings** to `http://127.0.0.1:8000`.

### Tests

```bash
npm test             # unit tests: store persistence, API client, pipeline (Node's built-in test runner)
./scripts/smoke.sh   # headless end-to-end: mock backend + Electron with a fake microphone
```

The smoke test drives the real renderer through settings → record → upload →
transcribe → import → history → copy → error/retry and prints a per-step
report. It uses `xvfb-run` automatically when no display is available.

## Building installers

```bash
npm run dist:win     # Windows: dist/MeetingScribe Setup 0.1.0.exe   (NSIS installer)
npm run dist:mac     # macOS:   dist/MeetingScribe-0.1.0.dmg          (x64 + arm64)
npm run dist         # current platform
npm run pack         # unpacked app folder in dist/ (fast sanity check)
```

Notes:

- Build the `.dmg` on macOS and the `.exe` on Windows (or Windows via Wine on
  Linux/macOS). Cross-building macOS from Windows/Linux is not supported by
  electron-builder.
- macOS: the app declares `NSMicrophoneUsageDescription` and the
  `audio-input` entitlement (`build/entitlements.mac.plist`). For distribution
  outside your own machine you'll want to code-sign and notarize — set
  `CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_ID` etc. per electron-builder docs.
  Unsigned builds still run locally (right-click → Open on first launch).
- Windows: the NSIS installer lets the user pick the install directory and
  creates a desktop shortcut. Unsigned builds show a SmartScreen warning.
- Packaging config lives in `electron-builder.yml`; the icon is
  `build/icon.png` (electron-builder converts it to `.ico` / `.icns`).

## Where data lives

All data is stored in Electron's per-user `userData` directory:

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\MeetingScribe\` |
| macOS | `~/Library/Application Support/MeetingScribe/` |

- `settings.json` — `{ "apiBaseUrl": "..." }`
- `history.json` — array of recordings with status, transcript, S3 key, job id
- `recordings/` — the `.wav` files you recorded and copies of imported files

Files are written atomically (temp file + rename); a corrupt `history.json` is
backed up as `history.json.corrupt-<timestamp>` rather than crashing the app.
The exact folder is shown at the bottom of the Settings screen.

## Error handling

| Situation | What the user sees |
| --- | --- |
| No base URL configured | Banner on the Record screen + job fails with "Open Settings and enter the API base URL" |
| Backend unreachable / offline | "Backend refused the connection…" / "Could not reach the backend…" with a Retry button |
| Non-2xx or malformed backend response | Status code + backend `detail` message |
| Presigned upload rejected/expired | "Upload failed: storage returned 403…" |
| Transcription `status: error` | "Transcription failed: <backend error>" |
| Unsupported import type | "Unsupported file type ".ogg". Please choose a .wav, .mp3 or .m4a file." |
| Mic permission denied / no mic / mic busy | Specific message; on macOS the system permission prompt is triggered first |
| App closed mid-job | On next launch the job is marked failed with a hint to Retry |

## Project layout

```
src/main/main.js        Electron main: window, IPC handlers, file dialogs, import logic
src/main/preload.js     contextBridge API exposed to the renderer (window.api)
src/main/store.js       JSON persistence for settings + history (atomic writes)
src/main/api.js         Backend REST client with friendly error mapping
src/main/pipeline.js    upload -> transcribe -> poll state machine, emits progress
src/renderer/           index.html, styles.css, app.js (screens), wav-recorder.js, pcm-worklet.js
scripts/mock-backend.js Mock API server for development/tests
scripts/smoke.sh        Headless end-to-end test
test/                   Unit tests (node --test)
electron-builder.yml    Windows NSIS + macOS DMG packaging
```

Security posture: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`,
strict CSP; the renderer only talks to the main process through the typed
`window.api` bridge. All network calls happen in the main process.

## Out of scope for this phase

Real-time/live transcription, system/meeting audio capture, and to-do list
features are intentionally not included.
