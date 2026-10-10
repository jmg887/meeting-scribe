'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, SOURCE } = require('../src/main/store');
const { formatTranscriptExport, applySpeakerNames } = require('../src/main/format');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-meta-'));
  const store = new Store(dir);
  const rec = store.addRecording({ filePath: '/x/meeting.wav', source: SOURCE.RECORDING });
  store.updateRecording(rec.id, {
    status: 'done',
    transcript: 'Speaker 1: Hello there.\n\nSpeaker 2: Hi.\n\nSpeaker 1: Bye.',
    summary: 'S',
    actionItems: ['A', 'B', 'C'],
  });
  return { dir, store, id: rec.id };
}

test('new records carry title/speakerNames/checkedActionItems defaults', () => {
  const { store, id } = fresh();
  const rec = store.getRecording(id);
  assert.equal(rec.title, null);
  assert.deepEqual(rec.speakerNames, {});
  assert.deepEqual(rec.checkedActionItems, []);
});

test('updateRecordingMeta: title is trimmed, capped, and blank clears it; persisted', () => {
  const { dir, store, id } = fresh();
  store.updateRecordingMeta(id, { title: '  Weekly sync  ' });
  assert.equal(store.getRecording(id).title, 'Weekly sync');
  store.updateRecordingMeta(id, { title: 'x'.repeat(500) });
  assert.equal(store.getRecording(id).title.length, 200);
  store.updateRecordingMeta(id, { title: '   ' });
  assert.equal(store.getRecording(id).title, null);
  store.updateRecordingMeta(id, { title: 'Final' });
  assert.equal(new Store(dir).getRecording(id).title, 'Final', 'survives reload');
  assert.equal(store.updateRecordingMeta('nope', { title: 'x' }), null);
});

test('updateRecordingMeta: speakerNames keeps only string->string, drops identity/blank renames', () => {
  const { store, id } = fresh();
  store.updateRecordingMeta(id, {
    speakerNames: { 'Speaker 1': ' James ', 'Speaker 2': '', 'Speaker 3': 'Speaker 3', 'Speaker 4': 42, bogus: null },
  });
  assert.deepEqual(store.getRecording(id).speakerNames, { 'Speaker 1': 'James' });
  store.updateRecordingMeta(id, { speakerNames: 'garbage' });
  assert.deepEqual(store.getRecording(id).speakerNames, {});
});

test('updateRecordingMeta: checkedActionItems are deduped, sorted, and bounded by actionItems length', () => {
  const { store, id } = fresh();
  store.updateRecordingMeta(id, { checkedActionItems: [2, 0, 2, -1, 7, 1.5, '1'] });
  assert.deepEqual(store.getRecording(id).checkedActionItems, [0, 2]);
  store.updateRecordingMeta(id, { checkedActionItems: null });
  assert.deepEqual(store.getRecording(id).checkedActionItems, []);
});

test('updateRecordingMeta ignores unrelated keys (cannot flip status or transcript)', () => {
  const { store, id } = fresh();
  store.updateRecordingMeta(id, { status: 'error', transcript: 'hacked', title: 'ok' });
  const rec = store.getRecording(id);
  assert.equal(rec.status, 'done');
  assert.match(rec.transcript, /^Speaker 1: Hello/);
  assert.equal(rec.title, 'ok');
});

test('applySpeakerNames rewrites only the label prefix, leaves text and unlabelled paragraphs alone', () => {
  const t = 'Speaker 1: Hello Speaker 2.\n\nSpeaker 2: Hi.\n\nNo label here.\n\nSpeaker 1: Bye.';
  assert.equal(applySpeakerNames(t, { 'Speaker 1': 'James' }),
    'James: Hello Speaker 2.\n\nSpeaker 2: Hi.\n\nNo label here.\n\nJames: Bye.');
  assert.equal(applySpeakerNames(t, {}), t);
  assert.equal(applySpeakerNames(t, null), t);
  assert.equal(applySpeakerNames(null, { 'Speaker 1': 'x' }), '');
});

test('Copy/Export output reflects speaker renames and ticked items', () => {
  const { store, id } = fresh();
  store.updateRecordingMeta(id, { speakerNames: { 'Speaker 1': 'James', 'Speaker 2': 'Mary' }, checkedActionItems: [1] });
  const out = formatTranscriptExport(store.getRecording(id));
  assert.equal(out,
    'SUMMARY:\nS\n\nACTION ITEMS:\n- [ ] A\n- [x] B\n- [ ] C\n\nTRANSCRIPT:\nJames: Hello there.\n\nMary: Hi.\n\nJames: Bye.');
});

test('records from before this feature load without the new keys and still format correctly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-old2-'));
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({
    version: 1,
    recordings: [{ id: 'old', createdAt: 1, updatedAt: 1, source: 'import', originalName: 'a.mp3', filePath: '/x/a.mp3',
      status: 'done', transcript: 'Speaker 1: Old.', summary: 'S', actionItems: ['A'], error: null }],
  }));
  const store = new Store(dir);
  const rec = store.getRecording('old');
  assert.equal(rec.title, undefined);
  assert.equal(formatTranscriptExport(rec), 'SUMMARY:\nS\n\nACTION ITEMS:\n- [ ] A\n\nTRANSCRIPT:\nSpeaker 1: Old.');
  // Editing an old record works and backfills the keys.
  store.updateRecordingMeta('old', { title: 'Renamed', checkedActionItems: [0] });
  const after = store.getRecording('old');
  assert.equal(after.title, 'Renamed');
  assert.deepEqual(after.checkedActionItems, [0]);
});
