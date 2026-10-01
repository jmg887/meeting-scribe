'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, SOURCE } = require('../src/main/store');
const { Pipeline, wavDurationSeconds, isSupportedAudio, SUPPORTED_EXTENSIONS, supportedExtensionsLabel } = require('../src/main/pipeline');
const { ApiClient, ApiError } = require('../src/main/api');
const { createMockBackend } = require('../scripts/mock-backend');

function makeWav(dir, seconds = 2, rate = 16000) {
  const data = Buffer.alloc(seconds * rate * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  const p = path.join(dir, 'clip.wav');
  fs.writeFileSync(p, Buffer.concat([h, data]));
  return p;
}

function setup(backendOpts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-pipe-'));
  const store = new Store(dir);
  const backend = createMockBackend({ delayMs: 200, ...backendOpts });
  return { dir, store, backend };
}

test('wav header duration + extension check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-wav-'));
  const p = makeWav(dir, 3);
  assert.equal(wavDurationSeconds(p), 3);
  for (const ext of ['wav', 'mp3', 'm4a', 'ogg', 'flac', 'aac', 'opus']) {
    assert.equal(isSupportedAudio(`a.${ext}`), true, ext);
    assert.equal(isSupportedAudio(`a.${ext.toUpperCase()}`), true, `${ext} (upper)`);
  }
  for (const ext of ['wma', 'webm', 'mp4', 'txt', '']) {
    assert.equal(isSupportedAudio(`a.${ext}`), false, ext || '(none)');
  }
  assert.deepEqual(SUPPORTED_EXTENSIONS, ['.wav', '.mp3', '.m4a', '.ogg', '.flac', '.aac', '.opus']);
  assert.equal(supportedExtensionsLabel('or'), '.wav, .mp3, .m4a, .ogg, .flac, .aac or .opus');
  fs.writeFileSync(path.join(dir, 'x.wav'), 'nope');
  assert.equal(wavDurationSeconds(path.join(dir, 'x.wav')), null);
});

test('happy path: saved -> uploading -> transcribing -> done', async () => {
  const { dir, store, backend } = setup();
  const port = await backend.listen();
  store.updateSettings({ apiBaseUrl: `http://127.0.0.1:${port}/` });
  const rec = store.addRecording({ filePath: makeWav(dir), source: SOURCE.RECORDING });

  const pipeline = new Pipeline(store, { pollIntervalMs: 50 });
  const seen = [];
  pipeline.on('progress', (r) => seen.push(r.status));
  const final = await pipeline.run(rec.id);
  await backend.close();

  assert.equal(final.status, 'done');
  assert.match(final.transcript, /mock transcript/);
  assert.ok(final.s3Key && final.jobId);
  assert.deepEqual([...new Set(seen)], ['uploading', 'transcribing', 'done']);
  assert.equal(backend.uploads.get(final.s3Key).length, fs.statSync(rec.filePath).size);
  assert.equal(store.getRecording(rec.id).status, 'done');
});

test('backend reports transcription error -> status error with message', async () => {
  const { dir, store, backend } = setup({ fail: true });
  const port = await backend.listen();
  store.updateSettings({ apiBaseUrl: `http://127.0.0.1:${port}` });
  const rec = store.addRecording({ filePath: makeWav(dir), source: SOURCE.IMPORT });
  const final = await new Pipeline(store, { pollIntervalMs: 50 }).run(rec.id);
  await backend.close();
  assert.equal(final.status, 'error');
  assert.match(final.error, /Transcription failed: Mock transcription failure/);
  assert.ok(final.jobId, 'jobId retained so UI can show failure at transcribing step');
});

test('unreachable backend -> friendly network error, no throw', async () => {
  const { dir, store } = setup();
  store.updateSettings({ apiBaseUrl: 'http://127.0.0.1:1' });
  const rec = store.addRecording({ filePath: makeWav(dir), source: SOURCE.RECORDING });
  const final = await new Pipeline(store).run(rec.id);
  assert.equal(final.status, 'error');
  assert.match(final.error, /refused the connection|Could not reach/);
});

test('missing base URL -> clear settings error', async () => {
  const { dir, store } = setup();
  const rec = store.addRecording({ filePath: makeWav(dir), source: SOURCE.RECORDING });
  const final = await new Pipeline(store).run(rec.id);
  assert.equal(final.status, 'error');
  assert.match(final.error, /Open Settings/);
});

test('missing file on disk -> error', async () => {
  const { store } = setup();
  store.updateSettings({ apiBaseUrl: 'http://127.0.0.1:1' });
  const rec = store.addRecording({ filePath: '/definitely/not/here.wav', source: SOURCE.RECORDING });
  const final = await new Pipeline(store).run(rec.id);
  assert.equal(final.status, 'error');
  assert.match(final.error, /missing from disk/);
});

test('ApiClient validates response shapes and http errors', async () => {
  const http = require('http');
  const srv = http.createServer((req, res) => {
    if (req.url === '/upload-url') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"nope":1}'); }
    if (req.url === '/transcribe') { res.writeHead(500); return res.end('{"detail":"boom"}'); }
    res.writeHead(200); res.end('<html>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const api = new ApiClient(`http://127.0.0.1:${srv.address().port}`);
  await assert.rejects(api.requestUploadUrl('a.wav'), (e) => e instanceof ApiError && e.code === 'bad_response');
  await assert.rejects(api.startTranscription('k'), (e) => e.code === 'http' && /500/.test(e.message) && /boom/.test(e.message));
  await assert.rejects(api.getStatus('j'), (e) => e.code === 'bad_response');
  srv.close();
  assert.throws(() => new ApiClient('ftp://x').assertConfigured(), /http/);
});

test('transcribe body includes num_speakers only when set', () => {
  assert.deepEqual(ApiClient.transcribeBody('k'), { s3_key: 'k' });
  assert.deepEqual(ApiClient.transcribeBody('k', {}), { s3_key: 'k' });
  assert.deepEqual(ApiClient.transcribeBody('k', { numSpeakers: null }), { s3_key: 'k' });
  assert.deepEqual(ApiClient.transcribeBody('k', { numSpeakers: undefined }), { s3_key: 'k' });
  assert.deepEqual(ApiClient.transcribeBody('k', { numSpeakers: 0 }), { s3_key: 'k' });
  assert.deepEqual(ApiClient.transcribeBody('k', { numSpeakers: 3 }), { s3_key: 'k', num_speakers: 3 });
  // Serialized form must not carry the key at all when unset (no "num_speakers": null)
  assert.equal(JSON.stringify(ApiClient.transcribeBody('k', { numSpeakers: null })), '{"s3_key":"k"}');
});

test('pipeline sends num_speakers from settings, omits it when blank', async () => {
  const { dir, store, backend } = setup();
  const port = await backend.listen();
  store.updateSettings({ apiBaseUrl: `http://127.0.0.1:${port}`, numSpeakers: 3 });

  const withHint = store.addRecording({ filePath: makeWav(dir), source: SOURCE.RECORDING });
  const r1 = await new Pipeline(store, { pollIntervalMs: 50 }).run(withHint.id);
  assert.equal(r1.status, 'done');
  assert.deepEqual(backend.jobs.get(r1.jobId).requestBody, { s3_key: r1.s3Key, num_speakers: 3 });
  assert.match(r1.transcript, /num_speakers=3/);

  store.updateSettings({ numSpeakers: '' });
  const without = store.addRecording({ filePath: makeWav(dir), source: SOURCE.IMPORT });
  const r2 = await new Pipeline(store, { pollIntervalMs: 50 }).run(without.id);
  await backend.close();
  assert.equal(r2.status, 'done');
  const body = backend.jobs.get(r2.jobId).requestBody;
  assert.deepEqual(body, { s3_key: r2.s3Key });
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'num_speakers'), false, 'key must be absent, not null');
  assert.match(r2.transcript, /auto-detect/);
});
