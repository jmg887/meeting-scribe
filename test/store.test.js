'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, STATUS, SOURCE } = require('../src/main/store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ms-store-'));
}

test('settings persist across instances and normalize trailing slashes', () => {
  const dir = tmpDir();
  const a = new Store(dir);
  assert.equal(a.getSettings().apiBaseUrl, '');
  a.updateSettings({ apiBaseUrl: 'http://1.2.3.4:8000/// ' });
  const b = new Store(dir);
  assert.equal(b.getSettings().apiBaseUrl, 'http://1.2.3.4:8000');
});

test('recordings are added, updated, listed newest-first and persisted', () => {
  const dir = tmpDir();
  const s = new Store(dir);
  const r1 = s.addRecording({ filePath: '/x/a.wav', source: SOURCE.RECORDING, durationSec: 3 });
  const r2 = s.addRecording({ filePath: '/x/b.mp3', source: SOURCE.IMPORT });
  assert.equal(r1.status, STATUS.SAVED);
  assert.equal(r2.source, 'import');
  assert.equal(r2.originalName, 'b.mp3');

  s.updateRecording(r1.id, { status: STATUS.DONE, transcript: 'hello', bogus: 'ignored' });
  const again = new Store(dir);
  const list = again.listRecordings();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, r2.id === list[0].id ? r2.id : list[0].id);
  const got = again.getRecording(r1.id);
  assert.equal(got.transcript, 'hello');
  assert.equal(got.status, 'done');
  assert.equal(got.bogus, undefined);
});

test('deleteRecording removes entry and file', () => {
  const dir = tmpDir();
  const s = new Store(dir);
  const f = path.join(s.recordingsDir, 'z.wav');
  fs.writeFileSync(f, 'abc');
  const r = s.addRecording({ filePath: f, source: SOURCE.RECORDING });
  assert.equal(s.deleteRecording(r.id), true);
  assert.equal(fs.existsSync(f), false);
  assert.equal(s.getRecording(r.id), null);
  assert.equal(s.deleteRecording('nope'), false);
});

test('corrupt history file is backed up rather than crashing', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'history.json'), '{not json');
  const s = new Store(dir);
  assert.deepEqual(s.listRecordings(), []);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('history.json.corrupt-')));
});

test('numSpeakers: blank/0/null -> null, integers 1..20 kept, out-of-range rejected, persisted', () => {
  const { normalizeNumSpeakers } = require('../src/main/store');
  for (const v of ['', '   ', null, undefined, 0, '0', NaN]) assert.equal(normalizeNumSpeakers(v), null, String(v));
  assert.equal(normalizeNumSpeakers(1), 1);
  assert.equal(normalizeNumSpeakers('3'), 3);
  assert.equal(normalizeNumSpeakers(' 20 '), 20);
  for (const v of [21, '21', -1, 2.5, '2.5', 'abc', '3e1']) assert.throws(() => normalizeNumSpeakers(v), /whole number|between 1 and 20/, String(v));

  const dir = tmpDir();
  const a = new Store(dir);
  assert.equal(a.getSettings().numSpeakers, null);
  a.updateSettings({ numSpeakers: '4' });
  assert.equal(a.getSettings().numSpeakers, 4);
  // Updating only the URL must not clobber the speaker count
  a.updateSettings({ apiBaseUrl: 'http://x:1' });
  assert.equal(a.getSettings().numSpeakers, 4);
  const b = new Store(dir);
  assert.equal(b.getSettings().numSpeakers, 4, 'persisted across launches');
  b.updateSettings({ numSpeakers: '' });
  assert.equal(new Store(dir).getSettings().numSpeakers, null, 'cleared value persists as null');
  assert.throws(() => b.updateSettings({ numSpeakers: 99 }), /between 1 and 20/);
  assert.equal(b.getSettings().numSpeakers, null, 'rejected update leaves settings unchanged');
});

test('numSpeakers: garbage in settings.json is sanitized to null on load', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ apiBaseUrl: 'http://x', numSpeakers: 'lots' }));
  assert.equal(new Store(dir).getSettings().numSpeakers, null);
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ apiBaseUrl: 'http://x', numSpeakers: 500 }));
  assert.equal(new Store(dir).getSettings().numSpeakers, null);
});
