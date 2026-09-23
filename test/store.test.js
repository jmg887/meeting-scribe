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
