#!/usr/bin/env node
'use strict';

/**
 * Mock transcription backend for local development and tests.
 *
 * Implements the same contract as the real API:
 *   POST /upload-url   { filename }  -> { upload_url, s3_key }
 *   PUT  /s3/<key>     raw bytes     (stands in for the presigned S3 URL)
 *   POST /transcribe   { s3_key }    -> { job_id }
 *   GET  /status/:id                 -> { job_id, status, transcript?, error? }
 *
 * Env:
 *   PORT              (default 8000)
 *   MOCK_DELAY_MS     how long a job stays "processing" (default 4000)
 *   MOCK_FAIL         set to "1" to make every job end in status "error"
 *
 * Also exported as createMockBackend() for programmatic use in tests.
 */

const http = require('http');
const crypto = require('crypto');

function createMockBackend({ delayMs = 4000, fail = false, logger = () => {} } = {}) {
  const uploads = new Map(); // s3_key -> Buffer
  const jobs = new Map(); // job_id -> { status, transcript, error, readyAt }

  function json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    logger(`${req.method} ${url.pathname}`);
    try {
      if (req.method === 'POST' && url.pathname === '/upload-url') {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        if (!body.filename) return json(res, 422, { detail: 'filename is required' });
        const key = `uploads/${crypto.randomUUID()}-${body.filename}`;
        const host = req.headers.host || `localhost:${server.address().port}`;
        return json(res, 200, { upload_url: `http://${host}/s3/${encodeURIComponent(key)}`, s3_key: key });
      }

      if (req.method === 'PUT' && url.pathname.startsWith('/s3/')) {
        const key = decodeURIComponent(url.pathname.slice(4));
        uploads.set(key, await readBody(req));
        res.writeHead(200);
        return res.end();
      }

      if (req.method === 'POST' && url.pathname === '/transcribe') {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        if (!body.s3_key) return json(res, 422, { detail: 's3_key is required' });
        if (!uploads.has(body.s3_key)) return json(res, 404, { detail: 'No such object in bucket' });
        const jobId = crypto.randomUUID();
        const bytes = uploads.get(body.s3_key).length;
        jobs.set(jobId, {
          readyAt: Date.now() + delayMs,
          fail,
          transcript: `[mock transcript] Received ${bytes} bytes for ${body.s3_key.split('-').slice(-1)[0]}.\n\nThis is placeholder text produced by the mock backend so you can exercise the app end-to-end without a real transcription service.`,
        });
        return json(res, 200, { job_id: jobId });
      }

      if (req.method === 'GET' && url.pathname.startsWith('/status/')) {
        const jobId = url.pathname.slice('/status/'.length);
        const job = jobs.get(jobId);
        if (!job) return json(res, 404, { detail: 'job not found' });
        if (Date.now() < job.readyAt) return json(res, 200, { job_id: jobId, status: 'processing' });
        if (job.fail) return json(res, 200, { job_id: jobId, status: 'error', error: 'Mock transcription failure (MOCK_FAIL=1)' });
        return json(res, 200, { job_id: jobId, status: 'done', transcript: job.transcript });
      }

      return json(res, 404, { detail: 'Not found' });
    } catch (err) {
      return json(res, 500, { detail: err.message });
    }
  });

  return {
    server,
    uploads,
    jobs,
    listen(port = 0) {
      return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createMockBackend };

if (require.main === module) {
  const port = Number(process.env.PORT || 8000);
  const backend = createMockBackend({
    delayMs: Number(process.env.MOCK_DELAY_MS || 4000),
    fail: process.env.MOCK_FAIL === '1',
    logger: (line) => console.log(`[mock] ${line}`),
  });
  backend.listen(port).then((p) => {
    console.log(`Mock MeetingScribe backend listening on http://127.0.0.1:${p}`);
    console.log(`Set the app's API base URL to: http://127.0.0.1:${p}`);
  });
}
