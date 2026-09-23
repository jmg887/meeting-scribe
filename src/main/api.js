'use strict';

/**
 * Thin client for the MeetingScribe transcription backend.
 *
 *   POST {base}/upload-url      { filename }  -> { upload_url, s3_key }
 *   PUT  {upload_url}           raw bytes
 *   POST {base}/transcribe      { s3_key }    -> { job_id }
 *   GET  {base}/status/{job_id}               -> { status, transcript?, error? }
 *
 * Uses the global `fetch` available in Node 18+/Electron. Pure Node so it can
 * be unit-tested against the mock backend in scripts/mock-backend.js.
 */

const fs = require('fs/promises');
const { normalizeBaseUrl } = require('./store');

const DEFAULT_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 10 * 60_000; // large files on slow links

/** Error with a user-facing message and a machine-readable code. */
class ApiError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'ApiError';
    this.code = code; // 'no_base_url' | 'network' | 'timeout' | 'http' | 'bad_response' | 'transcription_failed'
    this.details = details;
  }
}

function friendlyNetworkMessage(err, baseUrl) {
  const cause = err && err.cause ? err.cause : err;
  const code = cause && cause.code;
  if (err && err.name === 'AbortError') {
    return { code: 'timeout', message: `The request to ${baseUrl} timed out. Check your connection and that the backend is running.` };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { code: 'network', message: `Could not resolve the backend host. Check the API base URL in Settings and your internet connection.` };
  }
  if (code === 'ECONNREFUSED') {
    return { code: 'network', message: `Backend refused the connection at ${baseUrl}. Is the server running and the port open?` };
  }
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH') {
    return { code: 'network', message: `Network error while contacting ${baseUrl}. You may be offline or the backend may be unreachable.` };
  }
  return { code: 'network', message: `Could not reach the backend (${(cause && cause.message) || err.message}). Check your internet connection and the API base URL in Settings.` };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS, baseUrlForMessages = url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    const { code, message } = friendlyNetworkMessage(err, baseUrlForMessages);
    throw new ApiError(message, code, err);
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonResponse(res, what) {
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed.detail || parsed.error || parsed.message || text;
    } catch (_) {
      /* not json */
    }
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
    throw new ApiError(
      `Backend returned ${res.status} ${res.statusText || ''} while ${what}${detail ? `: ${detail.slice(0, 300)}` : ''}`.trim(),
      'http',
      { status: res.status, body: text },
    );
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new ApiError(`Backend sent an unexpected (non-JSON) response while ${what}.`, 'bad_response', { body: text });
  }
}

class ApiClient {
  /**
   * @param {string} baseUrl e.g. http://1.2.3.4:8000
   */
  constructor(baseUrl) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  assertConfigured() {
    if (!this.baseUrl) {
      throw new ApiError('No backend API URL is configured. Open Settings and enter the API base URL.', 'no_base_url');
    }
    if (!/^https?:\/\//i.test(this.baseUrl)) {
      throw new ApiError(`The API base URL "${this.baseUrl}" must start with http:// or https://.`, 'no_base_url');
    }
  }

  /** @returns {Promise<{upload_url:string, s3_key:string}>} */
  async requestUploadUrl(filename) {
    this.assertConfigured();
    const res = await fetchWithTimeout(
      `${this.baseUrl}/upload-url`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      },
      DEFAULT_TIMEOUT_MS,
      this.baseUrl,
    );
    const data = await readJsonResponse(res, 'requesting an upload URL');
    if (!data || typeof data.upload_url !== 'string' || typeof data.s3_key !== 'string') {
      throw new ApiError('Backend response for /upload-url is missing upload_url or s3_key.', 'bad_response', data);
    }
    return data;
  }

  /** PUT the raw file bytes to the presigned URL. */
  async uploadFile(uploadUrl, filePath, contentType) {
    const bytes = await fs.readFile(filePath);
    const headers = { 'Content-Length': String(bytes.length) };
    if (contentType) headers['Content-Type'] = contentType;
    const res = await fetchWithTimeout(
      uploadUrl,
      { method: 'PUT', headers, body: bytes },
      UPLOAD_TIMEOUT_MS,
      'the upload server',
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ApiError(
        `Upload failed: storage returned ${res.status} ${res.statusText || ''}. The upload link may have expired — please try again.`.trim(),
        'http',
        { status: res.status, body },
      );
    }
    return { sizeBytes: bytes.length };
  }

  /** @returns {Promise<{job_id:string}>} */
  async startTranscription(s3Key) {
    this.assertConfigured();
    const res = await fetchWithTimeout(
      `${this.baseUrl}/transcribe`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ s3_key: s3Key }),
      },
      DEFAULT_TIMEOUT_MS,
      this.baseUrl,
    );
    const data = await readJsonResponse(res, 'starting transcription');
    if (!data || typeof data.job_id !== 'string') {
      throw new ApiError('Backend response for /transcribe is missing job_id.', 'bad_response', data);
    }
    return data;
  }

  /** @returns {Promise<{job_id:string, status:string, transcript?:string, error?:string}>} */
  async getStatus(jobId) {
    this.assertConfigured();
    const res = await fetchWithTimeout(
      `${this.baseUrl}/status/${encodeURIComponent(jobId)}`,
      { method: 'GET' },
      DEFAULT_TIMEOUT_MS,
      this.baseUrl,
    );
    const data = await readJsonResponse(res, 'checking transcription status');
    if (!data || typeof data.status !== 'string') {
      throw new ApiError('Backend response for /status is missing a status field.', 'bad_response', data);
    }
    return data;
  }

  /**
   * Poll /status until done or error.
   * @param {string} jobId
   * @param {object} [opts]
   * @param {number} [opts.intervalMs=3000]
   * @param {number} [opts.maxWaitMs]  give up after this long (default 2h)
   * @param {number} [opts.maxConsecutiveFailures=5] tolerate transient poll failures
   * @param {(status:object)=>void} [opts.onPoll]
   * @param {AbortSignal} [opts.signal]
   */
  async waitForTranscript(jobId, opts = {}) {
    const intervalMs = opts.intervalMs ?? 3000;
    const maxWaitMs = opts.maxWaitMs ?? 2 * 60 * 60_000;
    const maxFailures = opts.maxConsecutiveFailures ?? 5;
    const started = Date.now();
    let failures = 0;

    for (;;) {
      if (opts.signal && opts.signal.aborted) {
        throw new ApiError('Transcription was cancelled.', 'cancelled');
      }
      let data;
      try {
        data = await this.getStatus(jobId);
        failures = 0;
      } catch (err) {
        failures += 1;
        if (err.code === 'http' && err.details && err.details.status === 404) throw err;
        if (failures >= maxFailures) throw err;
        await sleep(intervalMs, opts.signal);
        continue;
      }
      if (opts.onPoll) opts.onPoll(data);

      if (data.status === 'done') {
        return typeof data.transcript === 'string' ? data.transcript : '';
      }
      if (data.status === 'error') {
        throw new ApiError(
          `Transcription failed${data.error ? `: ${data.error}` : '.'}`,
          'transcription_failed',
          data,
        );
      }
      if (Date.now() - started > maxWaitMs) {
        throw new ApiError('Transcription is taking too long. Please try again later.', 'timeout');
      }
      await sleep(intervalMs, opts.signal);
    }
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    }
  });
}

module.exports = { ApiClient, ApiError };
