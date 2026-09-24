/* Runs inside the renderer when MEETINGSCRIBE_SMOKE=1. Returns a promise resolving to a result object. */
(async () => {
  const log = (...a) => console.log('[smoke]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const result = { ok: false, steps: [] };
  const step = (name, ok, info) => { result.steps.push({ name, ok, info }); log(name, ok ? 'OK' : 'FAIL', info || ''); };

  try {
    const baseUrl = window.__SMOKE_BASE_URL__ || 'http://127.0.0.1:8765';

    // Settings screen: save base URL
    $('.nav-btn[data-screen="settings"]').click();
    $('#api-base-url').value = baseUrl;
    $('#settings-form').requestSubmit();
    await sleep(300);
    const saved = await window.api.settings.get();
    step('settings.save', saved.apiBaseUrl === baseUrl, saved.apiBaseUrl);

    // Connection test
    $('#test-connection-btn').click();
    await sleep(1500);
    step('settings.testConnection', /reachable/i.test($('#settings-status').textContent), $('#settings-status').textContent);

    // Home: record ~2s using the fake mic
    $('.nav-btn[data-screen="home"]').click();
    $('#record-btn').click();
    await sleep(2200);
    const recording = $('#record-btn').classList.contains('recording');
    const timerText = $('#timer').textContent;
    step('record.start', recording && timerText !== '00:00', timerText);
    $('#record-btn').click();

    // Wait for the status card to reach done
    let rec = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const list = await window.api.recordings.list();
      rec = list[0];
      if (rec && (rec.status === 'done' || rec.status === 'error')) break;
    }
    step('record.pipeline', !!rec && rec.status === 'done', rec && (rec.status + ' ' + (rec.error || '')));
    step('record.duration', !!rec && rec.durationSec > 1.5 && rec.durationSec < 3.5, rec && rec.durationSec);
    step('record.source', !!rec && rec.source === 'recording', rec && rec.source);
    step('record.wavSize', !!rec && rec.sizeBytes > 16000 * 2 * 1.5, rec && rec.sizeBytes);

    const stepsDone = Array.from(document.querySelectorAll('#status-card .steps li')).every((li) => li.classList.contains('complete'));
    step('ui.statusSteps', stepsDone && !$('#status-card').classList.contains('hidden'));

    // Import flow via path (bypasses native dialog) — unsupported ext must fail gracefully
    let unsupportedMsg = '';
    try { await window.api.recordings.importPath(rec.filePath.replace(/\.wav$/, '.ogg')); } catch (e) { unsupportedMsg = e.message; }
    step('import.unsupported', /Unsupported file type/.test(unsupportedMsg), unsupportedMsg);

    const imported = await window.api.recordings.importPath(rec.filePath);
    let imp = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      imp = await window.api.recordings.get(imported.id);
      if (imp.status === 'done' || imp.status === 'error') break;
    }
    step('import.pipeline', imp && imp.status === 'done' && imp.source === 'import', imp && imp.status);

    // History screen renders both + transcript view
    $('.nav-btn[data-screen="history"]').click();
    await sleep(200);
    const items = document.querySelectorAll('.history-item');
    step('history.list', items.length === 2, items.length);
    items[0].click();
    await sleep(100);
    const text = $('.transcript-text') && $('.transcript-text').textContent;
    step('history.transcript', !!text && /mock transcript/.test(text));
    const tags = Array.from(document.querySelectorAll('.history-item .tag')).map((t) => t.textContent);
    step('history.sourceTags', tags.includes('Imported') && tags.includes('Recorded'), tags.join(','));

    // Copy to clipboard
    await window.api.transcript.copy(text);
    step('transcript.copy', true);

    // Error path: point at dead backend, retry -> error status + retry button
    await window.api.settings.update({ apiBaseUrl: 'http://127.0.0.1:1' });
    await window.api.recordings.retry(rec.id);
    let failed = null;
    for (let i = 0; i < 20; i++) { await sleep(300); failed = await window.api.recordings.get(rec.id); if (failed.status === 'error') break; }
    step('error.unreachable', failed && failed.status === 'error' && /refused|reach/i.test(failed.error), failed && failed.error);
    await sleep(200);
    step('ui.errorTag', !!document.querySelector('.history-item .tag.status-error'));

    result.ok = result.steps.every((s) => s.ok);
  } catch (err) {
    result.error = err.message + '\n' + err.stack;
  }
  return result;
})();
