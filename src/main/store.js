'use strict';

/**
 * Local persistence for MeetingScribe.
 *
 * Two JSON files live in the app's userData directory:
 *   - settings.json  -> { apiBaseUrl }
 *   - history.json   -> { recordings: [ ... ] }
 *
 * Everything is written atomically (write temp file, then rename) so a crash
 * mid-write never corrupts the history. Pure Node — no Electron dependency —
 * so it can be unit-tested directly.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SETTINGS = Object.freeze({
  apiBaseUrl: '',
});

/** Allowed recording statuses, in pipeline order. */
const STATUS = Object.freeze({
  SAVED: 'saved',
  UPLOADING: 'uploading',
  TRANSCRIBING: 'transcribing',
  DONE: 'done',
  ERROR: 'error',
});

const SOURCE = Object.freeze({
  RECORDING: 'recording',
  IMPORT: 'import',
});

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Corrupt file: keep a backup so the user can recover, then start fresh.
      try {
        fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
      } catch (_) {
        /* ignore */
      }
    }
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function normalizeBaseUrl(url) {
  if (typeof url !== 'string') return '';
  return url.trim().replace(/\/+$/, '');
}

class Store {
  /**
   * @param {string} dataDir directory where settings.json / history.json live
   */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.settingsFile = path.join(dataDir, 'settings.json');
    this.historyFile = path.join(dataDir, 'history.json');
    this.recordingsDir = path.join(dataDir, 'recordings');
    fs.mkdirSync(this.recordingsDir, { recursive: true });

    this._settings = { ...DEFAULT_SETTINGS, ...readJson(this.settingsFile, {}) };
    const hist = readJson(this.historyFile, { recordings: [] });
    this._recordings = Array.isArray(hist.recordings) ? hist.recordings : [];
  }

  // ---------------------------------------------------------------- settings

  getSettings() {
    return { ...this._settings };
  }

  updateSettings(patch) {
    const next = { ...this._settings };
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'apiBaseUrl')) {
      next.apiBaseUrl = normalizeBaseUrl(patch.apiBaseUrl);
    }
    this._settings = next;
    writeJsonAtomic(this.settingsFile, this._settings);
    return this.getSettings();
  }

  // -------------------------------------------------------------- recordings

  /** Newest first. */
  listRecordings() {
    return [...this._recordings].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  getRecording(id) {
    const rec = this._recordings.find((r) => r.id === id);
    return rec ? { ...rec } : null;
  }

  /**
   * @param {object} data
   * @param {string} data.filePath      absolute path of the local audio file
   * @param {string} data.originalName  display filename
   * @param {number|null} data.durationSec
   * @param {'recording'|'import'} data.source
   * @param {number} [data.sizeBytes]
   */
  addRecording(data) {
    const now = Date.now();
    const rec = {
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      source: data.source === SOURCE.IMPORT ? SOURCE.IMPORT : SOURCE.RECORDING,
      originalName: data.originalName || path.basename(data.filePath),
      filePath: data.filePath,
      sizeBytes: Number.isFinite(data.sizeBytes) ? data.sizeBytes : null,
      durationSec: Number.isFinite(data.durationSec) ? data.durationSec : null,
      status: STATUS.SAVED,
      s3Key: null,
      jobId: null,
      transcript: null,
      error: null,
    };
    this._recordings.push(rec);
    this._flushHistory();
    return { ...rec };
  }

  updateRecording(id, patch) {
    const idx = this._recordings.findIndex((r) => r.id === id);
    if (idx === -1) return null;
    const allowed = [
      'status',
      's3Key',
      'jobId',
      'transcript',
      'error',
      'durationSec',
      'sizeBytes',
      'originalName',
    ];
    const next = { ...this._recordings[idx] };
    for (const key of allowed) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, key)) {
        next[key] = patch[key];
      }
    }
    next.updatedAt = Date.now();
    this._recordings[idx] = next;
    this._flushHistory();
    return { ...next };
  }

  deleteRecording(id, { deleteFile = true } = {}) {
    const idx = this._recordings.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    const [rec] = this._recordings.splice(idx, 1);
    this._flushHistory();
    if (deleteFile && rec.filePath) {
      try {
        fs.unlinkSync(rec.filePath);
      } catch (_) {
        /* file may already be gone */
      }
    }
    return true;
  }

  _flushHistory() {
    writeJsonAtomic(this.historyFile, { version: 1, recordings: this._recordings });
  }
}

module.exports = { Store, STATUS, SOURCE, DEFAULT_SETTINGS, normalizeBaseUrl };
