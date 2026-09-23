'use strict';

const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

const { Store, SOURCE, STATUS } = require('./store');
const { Pipeline, isSupportedAudio, wavDurationSeconds, SUPPORTED_EXTENSIONS } = require('./pipeline');
const { ApiClient } = require('./api');

let mainWindow = null;
let store = null;
let pipeline = null;

// Developer / CI hooks (all opt-in via environment variables):
//   MEETINGSCRIBE_USER_DATA=<dir>  use a custom data directory
//   MEETINGSCRIBE_FAKE_MIC=1       feed Chromium's synthetic microphone (headless testing)
//   MEETINGSCRIBE_SMOKE=1          run scripts/smoke-renderer.js inside the window, then quit
//   MEETINGSCRIBE_SMOKE_SCRIPT=<p> override the smoke script path (needed for packaged builds)
if (process.env.MEETINGSCRIBE_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.MEETINGSCRIBE_USER_DATA));
}
if (process.env.MEETINGSCRIBE_FAKE_MIC === '1') {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

// ---------------------------------------------------------------- helpers

function timestampName(prefix, ext) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `${prefix}_${stamp}${ext}`;
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').slice(0, 120) || 'audio';
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** Wrap an IPC handler so failures become { ok:false, error } instead of thrown exceptions. */
function safe(handler) {
  return async (event, ...args) => {
    try {
      const data = await handler(event, ...args);
      return { ok: true, data };
    } catch (err) {
      console.error('[ipc]', err);
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  };
}

async function ensureMicrophonePermission() {
  if (process.platform !== 'darwin') return true;
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return true;
  if (status === 'denied' || status === 'restricted') return false;
  return systemPreferences.askForMediaAccess('microphone');
}

// ------------------------------------------------------------------ window

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 760,
    minHeight: 520,
    title: 'MeetingScribe',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    backgroundColor: '#f6f7fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.env.MEETINGSCRIBE_SMOKE === '1') {
    mainWindow.webContents.on('console-message', (_e, _level, message) => console.log('[renderer]', message));
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const scriptPath = process.env.MEETINGSCRIBE_SMOKE_SCRIPT
          || path.join(__dirname, '..', '..', 'scripts', 'smoke-renderer.js');
        const script = fs.readFileSync(scriptPath, 'utf8');
        const result = await mainWindow.webContents.executeJavaScript(script, true);
        console.log('SMOKE_RESULT ' + JSON.stringify(result));
        app.exit(result && result.ok ? 0 : 1);
      } catch (err) {
        console.log('SMOKE_RESULT ' + JSON.stringify({ ok: false, error: err.message }));
        app.exit(1);
      }
    });
  }

  // Open external links in the OS browser rather than inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// --------------------------------------------------------------------- IPC

function registerIpc() {
  // Settings
  ipcMain.handle('settings:get', safe(() => store.getSettings()));
  ipcMain.handle('settings:update', safe((_e, patch) => store.updateSettings(patch)));

  // History
  ipcMain.handle('recordings:list', safe(() => store.listRecordings()));
  ipcMain.handle('recordings:get', safe((_e, id) => store.getRecording(id)));
  ipcMain.handle('recordings:delete', safe((_e, id) => store.deleteRecording(id)));
  ipcMain.handle('recordings:setDuration', safe((_e, { id, durationSec }) => {
    if (!Number.isFinite(durationSec)) throw new Error('Invalid duration.');
    return store.updateRecording(id, { durationSec });
  }));
  ipcMain.handle('recordings:retry', safe((_e, id) => {
    const rec = store.getRecording(id);
    if (!rec) throw new Error('Recording not found.');
    pipeline.run(id); // fire and forget; progress arrives via events
    return store.getRecording(id);
  }));

  // Live recording: renderer sends encoded WAV bytes, we persist + start pipeline
  ipcMain.handle('recordings:saveWav', safe(async (_e, { buffer, durationSec }) => {
    if (!buffer || !(buffer instanceof ArrayBuffer || ArrayBuffer.isView(buffer))) {
      throw new Error('No audio data received from the recorder.');
    }
    const bytes = Buffer.from(buffer.buffer || buffer, buffer.byteOffset || 0, buffer.byteLength);
    if (bytes.length < 100) throw new Error('The recording is empty. Please try again.');
    const fileName = timestampName('recording', '.wav');
    const filePath = path.join(store.recordingsDir, fileName);
    await fsp.writeFile(filePath, bytes);
    const rec = store.addRecording({
      filePath,
      originalName: fileName,
      durationSec: Number.isFinite(durationSec) ? durationSec : wavDurationSeconds(filePath),
      sizeBytes: bytes.length,
      source: SOURCE.RECORDING,
    });
    pipeline.run(rec.id);
    return rec;
  }));

  // Import an existing file via native picker
  ipcMain.handle('recordings:import', safe(async (_e, { durationSec } = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Audio File',
      properties: ['openFile'],
      filters: [
        { name: 'Audio Files', extensions: ['wav', 'mp3', 'm4a'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const src = result.filePaths[0];
    return importFromPath(src, durationSec);
  }));

  // Import via drag & drop (renderer passes a path) — same rules as picker
  ipcMain.handle('recordings:importPath', safe(async (_e, { filePath, durationSec }) => importFromPath(filePath, durationSec)));

  // Give the renderer a readable copy so it can compute duration for imports
  ipcMain.handle('files:read', safe(async (_e, filePath) => {
    const data = await fsp.readFile(filePath);
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }));

  // Transcript actions
  ipcMain.handle('transcript:copy', safe((_e, text) => {
    clipboard.writeText(text || '');
    return true;
  }));
  ipcMain.handle('transcript:export', safe(async (_e, { id }) => {
    const rec = store.getRecording(id);
    if (!rec || !rec.transcript) throw new Error('No transcript to export.');
    const base = sanitizeFilename(rec.originalName.replace(/\.[^.]+$/, ''));
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export transcript',
      defaultPath: `${base}_transcript.txt`,
      filters: [{ name: 'Text', extensions: ['txt'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fsp.writeFile(result.filePath, rec.transcript, 'utf8');
    return result.filePath;
  }));

  // Connectivity check for the Settings screen
  ipcMain.handle('api:testConnection', safe(async (_e, baseUrl) => {
    const api = new ApiClient(baseUrl);
    api.assertConfigured();
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    try {
      // Any HTTP response (even 404) proves the backend is reachable.
      const res = await fetch(`${api.baseUrl}/status/connection-test`, { signal: controller.signal });
      return { reachable: true, status: res.status };
    } catch (err) {
      const msg = err.name === 'AbortError'
        ? 'Timed out — the backend did not respond within 8 seconds.'
        : `Could not reach the backend (${(err.cause && err.cause.code) || err.message}). Check the URL, your network, and that the port is open.`;
      return { reachable: false, message: msg };
    } finally {
      clearTimeout(t);
    }
  }));

  // Misc
  ipcMain.handle('app:openRecordingsFolder', safe(() => shell.openPath(store.recordingsDir)));
  ipcMain.handle('app:showInFolder', safe((_e, filePath) => shell.showItemInFolder(filePath)));
  ipcMain.handle('app:requestMic', safe(() => ensureMicrophonePermission()));
  ipcMain.handle('app:info', safe(() => ({
    version: app.getVersion(),
    platform: process.platform,
    dataDir: store.dataDir,
    supportedExtensions: SUPPORTED_EXTENSIONS,
  })));
}

async function importFromPath(src, durationSec) {
  if (!src) throw new Error('No file selected.');
  if (!isSupportedAudio(src)) {
    throw new Error(`Unsupported file type "${path.extname(src) || '(none)'}". Please choose a .wav, .mp3 or .m4a file.`);
  }
  let stat;
  try {
    stat = await fsp.stat(src);
  } catch (_) {
    throw new Error('The selected file could not be read.');
  }
  if (!stat.isFile() || stat.size === 0) throw new Error('The selected file is empty.');

  // Copy into our recordings folder so history keeps working if the original moves.
  const ext = path.extname(src).toLowerCase();
  const baseName = sanitizeFilename(path.basename(src, path.extname(src)));
  const destName = `${baseName}_${Date.now()}${ext}`;
  const dest = path.join(store.recordingsDir, destName);
  await fsp.copyFile(src, dest);

  let duration = Number.isFinite(durationSec) ? durationSec : null;
  if (duration === null && ext === '.wav') duration = wavDurationSeconds(dest);

  const rec = store.addRecording({
    filePath: dest,
    originalName: path.basename(src),
    durationSec: duration,
    sizeBytes: stat.size,
    source: SOURCE.IMPORT,
  });
  pipeline.run(rec.id);
  return rec;
}

// ----------------------------------------------------------------- startup

function bootstrap() {
  const dataDir = app.getPath('userData');
  store = new Store(dataDir);
  pipeline = new Pipeline(store);
  pipeline.on('progress', (rec) => sendToRenderer('recordings:progress', rec));

  // Anything left mid-flight from a previous session is no longer running.
  for (const rec of store.listRecordings()) {
    if (rec.status === STATUS.UPLOADING || rec.status === STATUS.TRANSCRIBING) {
      store.updateRecording(rec.id, {
        status: STATUS.ERROR,
        error: 'The app was closed before this finished. Use Retry to run it again.',
      });
    }
  }

  registerIpc();
  createWindow();
}

app.whenReady().then(() => {
  bootstrap();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (err) => {
  console.error('[main] uncaught', err);
  if (mainWindow) {
    dialog.showErrorBox('MeetingScribe error', err.message || String(err));
  }
});
