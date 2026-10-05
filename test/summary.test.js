'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, SOURCE } = require('../src/main/store');
const { Pipeline } = require('../src/main/pipeline');
const { ApiClient } = require('../src/main/api');
const { formatTranscriptExport } = require('../src/main/format');
const { createMockBackend } = require('../scripts/mock-backend');

function makeWav(dir, name = 'clip.wav') {
  const data = Buffer.alloc(16000 * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.concat([h, data]));
  return p;
}

test('formatTranscriptExport: no summary -> transcript verbatim, no headers', () => {
  const t = 'Para one.\n\nPara two.';
  assert.equal(formatTranscriptExport({ transcript: t }), t);
  assert.equal(formatTranscriptExport({ transcript: t, summary: null, actionItems: [] }), t);
  assert.equal(formatTranscriptExport({ transcript: t, summary: '   ', actionItems: ['x'] }), t, 'blank summary counts as none');
  assert.equal(formatTranscriptExport({ transcript: t, summary: null, summaryError: 'boom' }), t, 'summary error -> plain transcript');
  assert.equal(formatTranscriptExport({ transcript: t }).includes('TRANSCRIPT:'), false);
});

test('formatTranscriptExport: summary + action items -> exact layout', () => {
  const out = formatTranscriptExport({
    transcript: 'Hello.\n\nWorld.',
    summary: 'We met.',
    actionItems: ['Do A', '  Do B  ', '', 42],
  });
  assert.equal(out, 'SUMMARY:\nWe met.\n\nACTION ITEMS:\n- Do A\n- Do B\n\nTRANSCRIPT:\nHello.\n\nWorld.');
});

test('formatTranscriptExport: summary without action items omits ACTION ITEMS block', () => {
  const out = formatTranscriptExport({ transcript: 'T', summary: 'S', actionItems: [] });
  assert.equal(out, 'SUMMARY:\nS\n\nTRANSCRIPT:\nT');
  assert.equal(formatTranscriptExport({ transcript: 'T', summary: 'S' }), 'SUMMARY:\nS\n\nTRANSCRIPT:\nT', 'missing actionItems key');
});

test('summaryFromStatus normalises every shape the backend can send', () => {
  assert.deepEqual(ApiClient.summaryFromStatus({}), { summary: null, actionItems: [], summaryError: null });
  assert.deepEqual(ApiClient.summaryFromStatus({ summary: null, action_items: null, summary_error: null }),
    { summary: null, actionItems: [], summaryError: null });
  assert.deepEqual(ApiClient.summaryFromStatus({ summary: 'S', action_items: ['a', ' b ', '', null], summary_error: null }),
    { summary: 'S', actionItems: ['a', 'b'], summaryError: null });
  assert.deepEqual(ApiClient.summaryFromStatus({ summary: null, action_items: [], summary_error: 'LLM down' }),
    { summary: null, actionItems: [], summaryError: 'LLM down' });
  assert.deepEqual(ApiClient.summaryFromStatus({ summary: '', summary_error: '' }),
    { summary: null, actionItems: [], summaryError: null }, 'empty strings -> null');
});

async function runJob(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-sum-'));
  const store = new Store(dir);
  const backend = createMockBackend({ delayMs: 100 });
  const port = await backend.listen();
  store.updateSettings({ apiBaseUrl: `http://127.0.0.1:${port}` });
  const rec = store.addRecording({ filePath: makeWav(dir, name), source: SOURCE.RECORDING });
  const final = await new Pipeline(store, { pollIntervalMs: 30 }).run(rec.id);
  await backend.close();
  // Re-open the store to prove the fields survived the round trip to disk.
  return new Store(dir).getRecording(rec.id);
}

test('pipeline persists summary, action items and summary error from /status', async () => {
  const full = await runJob('meeting.wav');
  assert.equal(full.status, 'done');
  assert.match(full.summary, /reviewed the mock recording pipeline/);
  assert.deepEqual(full.actionItems, [
    'Verify the summary card renders above the transcript',
    'Confirm Copy and Export include the summary header',
  ]);
  assert.equal(full.summaryError, null);
  assert.match(formatTranscriptExport(full), /^SUMMARY:\n.+\n\nACTION ITEMS:\n- Verify.+\n- Confirm.+\n\nTRANSCRIPT:\n\[mock transcript\]/s);

  const noActions = await runJob('noactions.wav');
  assert.ok(noActions.summary);
  assert.deepEqual(noActions.actionItems, []);
  assert.equal(formatTranscriptExport(noActions).includes('ACTION ITEMS'), false);

  const failedSummary = await runJob('nosummary.wav');
  assert.equal(failedSummary.status, 'done', 'summary failure must NOT fail the transcript');
  assert.ok(failedSummary.transcript.length > 0);
  assert.equal(failedSummary.summary, null);
  assert.equal(failedSummary.summaryError, 'Mock summary model timed out');
  assert.equal(formatTranscriptExport(failedSummary), failedSummary.transcript);

  const legacy = await runJob('legacy.wav');
  assert.equal(legacy.status, 'done');
  assert.equal(legacy.summary, null);
  assert.deepEqual(legacy.actionItems, []);
  assert.equal(legacy.summaryError, null);
  assert.equal(formatTranscriptExport(legacy), legacy.transcript);
});

test('records written before this feature load without summary keys and format as plain transcript', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-old-'));
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({
    version: 1,
    recordings: [{ id: 'old', createdAt: 1, updatedAt: 1, source: 'recording', originalName: 'a.wav',
      filePath: '/x/a.wav', status: 'done', transcript: 'Old text.', error: null }],
  }));
  const rec = new Store(dir).getRecording('old');
  assert.equal(rec.summary, undefined);
  assert.equal(formatTranscriptExport(rec), 'Old text.');
});
