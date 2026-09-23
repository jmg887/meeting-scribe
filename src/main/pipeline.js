'use strict';

/**
 * Upload + transcribe pipeline.
 *
 *   saved -> uploading -> transcribing -> done | error
 *
 * Each step persists its state to the Store so the history screen always
 * reflects reality, and emits a `progress` event so the renderer can update
 * its status indicator live.
 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { ApiClient, ApiError } = require('./api');
const { STATUS } = require('./store');

const MIME_BY_EXT = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
};

const SUPPORTED_EXTENSIONS = Object.keys(MIME_BY_EXT);

function isSupportedAudio(filePath) {
  return SUPPORTED_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

function mimeFor(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/**
 * Read the duration of a canonical PCM WAV file from its header.
 * Returns null if the file is not a parseable WAV.
 */
function wavDurationSeconds(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(64 * 1024);
    const read = fs.readSync(fd, header, 0, header.length, 0);
    if (read < 12 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      return null;
    }
    let offset = 12;
    let byteRate = null;
    while (offset + 8 <= read) {
      const chunkId = header.toString('ascii', offset, offset + 4);
      const chunkSize = header.readUInt32LE(offset + 4);
      if (chunkId === 'fmt ') {
        byteRate = header.readUInt32LE(offset + 16);
      } else if (chunkId === 'data') {
        if (!byteRate) return null;
        const stat = fs.fstatSync(fd);
        // Some encoders write 0 / 0xFFFFFFFF for streaming WAVs; fall back to file size.
        const dataBytes = chunkSize > 0 && chunkSize !== 0xffffffff
          ? Math.min(chunkSize, stat.size - (offset + 8))
          : stat.size - (offset + 8);
        return dataBytes / byteRate;
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }
    return null;
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

class Pipeline extends EventEmitter {
  /**
   * @param {import('./store').Store} store
   * @param {object} [opts]
   * @param {number} [opts.pollIntervalMs=3000]
   */
  constructor(store, opts = {}) {
    super();
    this.store = store;
    this.pollIntervalMs = opts.pollIntervalMs ?? 3000;
    this._active = new Map(); // id -> AbortController
  }

  get activeCount() {
    return this._active.size;
  }

  isActive(id) {
    return this._active.has(id);
  }

  _emit(rec, extra = {}) {
    this.emit('progress', { ...rec, ...extra });
  }

  _update(id, patch) {
    const rec = this.store.updateRecording(id, patch);
    if (rec) this._emit(rec);
    return rec;
  }

  /**
   * Run (or re-run) the upload + transcribe flow for a stored recording.
   * Resolves with the final record; never rejects — errors are stored on the record.
   */
  async run(id) {
    const rec = this.store.getRecording(id);
    if (!rec) throw new Error(`Unknown recording ${id}`);
    if (this._active.has(id)) return rec;

    const controller = new AbortController();
    this._active.set(id, controller);

    try {
      if (!fs.existsSync(rec.filePath)) {
        throw new ApiError('The audio file is missing from disk, so it cannot be uploaded.', 'missing_file');
      }
      const { apiBaseUrl } = this.store.getSettings();
      const api = new ApiClient(apiBaseUrl);
      api.assertConfigured();

      // 1. Upload
      this._update(id, { status: STATUS.UPLOADING, error: null });
      const { upload_url: uploadUrl, s3_key: s3Key } = await api.requestUploadUrl(rec.originalName);
      const { sizeBytes } = await api.uploadFile(uploadUrl, rec.filePath, mimeFor(rec.filePath));
      this._update(id, { s3Key, sizeBytes });

      // 2. Transcribe
      const { job_id: jobId } = await api.startTranscription(s3Key);
      this._update(id, { status: STATUS.TRANSCRIBING, jobId });
      const transcript = await api.waitForTranscript(jobId, {
        intervalMs: this.pollIntervalMs,
        signal: controller.signal,
      });

      // 3. Done
      return this._update(id, { status: STATUS.DONE, transcript, error: null });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : `Unexpected error: ${err.message}`;
      return this._update(id, { status: STATUS.ERROR, error: message });
    } finally {
      this._active.delete(id);
    }
  }

  cancel(id) {
    const c = this._active.get(id);
    if (c) c.abort();
  }
}

module.exports = { Pipeline, isSupportedAudio, mimeFor, wavDurationSeconds, SUPPORTED_EXTENSIONS };
