/* Runs inside the renderer when MEETINGSCRIBE_SMOKE=1. Returns a promise resolving to a result object. */
(async () => {
  const log = (...a) => console.log('[smoke]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const result = { ok: false, steps: [] };
  const state0 = (item) => item.dataset.id;
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

    // Expected number of speakers: out-of-range rejected in the UI, nothing persisted
    const nsInput = $('#num-speakers');
    nsInput.value = '25';
    $('#settings-form').requestSubmit();
    await sleep(200);
    step('settings.numSpeakers.reject', /between 1 and 20/.test($('#settings-status').textContent) && (await window.api.settings.get()).numSpeakers === null, $('#settings-status').textContent);
    // Valid value persists; the first recording below must send num_speakers=3
    nsInput.value = '3';
    $('#settings-form').requestSubmit();
    await sleep(300);
    step('settings.numSpeakers.save', (await window.api.settings.get()).numSpeakers === 3 && nsInput.value === '3');

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
    step('record.numSpeakersSent', !!rec && /num_speakers=3/.test(rec.transcript || ''), rec && (rec.transcript || '').slice(0, 90));

    // Clear the hint via the UI; the import below must omit num_speakers entirely
    $('.nav-btn[data-screen="settings"]').click();
    $('#num-speakers').value = '';
    $('#settings-form').requestSubmit();
    await sleep(300);
    step('settings.numSpeakers.clear', (await window.api.settings.get()).numSpeakers === null);
    $('.nav-btn[data-screen="home"]').click();
    step('record.duration', !!rec && rec.durationSec > 1.5 && rec.durationSec < 3.5, rec && rec.durationSec);
    step('record.source', !!rec && rec.source === 'recording', rec && rec.source);
    step('record.wavSize', !!rec && rec.sizeBytes > 16000 * 2 * 1.5, rec && rec.sizeBytes);

    const stepsDone = Array.from(document.querySelectorAll('#status-card .steps li')).every((li) => li.classList.contains('complete'));
    step('ui.statusSteps', stepsDone && !$('#status-card').classList.contains('hidden'));

    // Import flow via path (bypasses native dialog) — unsupported ext must fail gracefully
    let unsupportedMsg = '';
    try { await window.api.recordings.importPath(rec.filePath.replace(/\.wav$/, '.wma')); } catch (e) { unsupportedMsg = e.message; }
    step('import.unsupported', /Unsupported file type ".wma"/.test(unsupportedMsg) && /\.opus/.test(unsupportedMsg), unsupportedMsg);
    step('ui.supportedFormats', $('#supported-formats').textContent === '.wav, .mp3, .m4a, .ogg, .flac, .aac, .opus', $('#supported-formats').textContent);

    // Newly supported extension (.ogg) must be accepted by the validator. The test harness
    // provides the file via window.__SMOKE_OGG_PATH__ (a copy of the wav with an .ogg name).
    if (window.__SMOKE_OGG_PATH__) {
      let oggRec = null;
      try { oggRec = await window.api.recordings.importPath(window.__SMOKE_OGG_PATH__); } catch (e) { oggRec = { error: e.message }; }
      step('import.oggAccepted', !!(oggRec && oggRec.id) && /\.ogg$/.test(oggRec.originalName), oggRec && (oggRec.error || oggRec.originalName));
      if (oggRec && oggRec.id) {
        // Let its pipeline settle so the later history assertions are deterministic.
        for (let i = 0; i < 60; i++) {
          const cur = await window.api.recordings.get(oggRec.id);
          if (!cur || cur.status === 'done' || cur.status === 'error') break;
          await sleep(500);
        }
      }
    }

    const imported = await window.api.recordings.importPath(rec.filePath);
    let imp = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      imp = await window.api.recordings.get(imported.id);
      if (imp.status === 'done' || imp.status === 'error') break;
    }
    step('import.pipeline', imp && imp.status === 'done' && imp.source === 'import', imp && imp.status);
    step('import.numSpeakersOmitted', !!imp && /auto-detect/.test(imp.transcript || ''), imp && (imp.transcript || '').slice(0, 90));

    // History screen renders both + transcript view
    $('.nav-btn[data-screen="history"]').click();
    await sleep(200);
    const items = document.querySelectorAll('.history-item');
    const expectedItems = window.__SMOKE_OGG_PATH__ ? 3 : 2; // recording + wav import (+ ogg import)
    step('history.list', items.length === expectedItems, items.length);
    items[0].click();
    await sleep(100);
    const text = $('.transcript-text') && $('.transcript-text').textContent;
    step('history.transcript', !!text && /mock transcript/.test(text));
    const paras = document.querySelectorAll('.transcript-text p');
    step('history.paragraphs', paras.length === 3, paras.length);
    const stored = (await window.api.recordings.get(state0(items[0]))).transcript;
    step('history.paragraphSplit', stored.split('\n\n').length === 3 && /\n/.test(paras[2].textContent) && paras[2].textContent === stored.split('\n\n')[2]);
    const tags = Array.from(document.querySelectorAll('.history-item .tag')).map((t) => t.textContent);
    step('history.sourceTags', tags.includes('Imported') && tags.includes('Recorded'), tags.join(','));

    // Copy to clipboard must use the stored text verbatim (paragraph breaks intact)
    // The 'nosummary-*.ogg' import -> backend reported summary_error -> card shows the muted note only
    const allRecs = await window.api.recordings.list();
    const noSumRec = allRecs.find((r) => /nosummary/.test(r.originalName));
    const noSumItem = Array.from(items).find((li) => li.dataset.id === (noSumRec && noSumRec.id));
    if (noSumItem) { noSumItem.click(); await sleep(150); }
    await window.api.transcript.copy(noSumRec.id);
    const clip = await window.api.transcript.readClipboard();
    step('transcript.copy.noSummary', !!noSumRec && noSumRec.summary === null && !!noSumRec.summaryError
      && clip === noSumRec.transcript && !clip.includes('SUMMARY:') && !clip.includes('TRANSCRIPT:'), clip.length);

    // Summary card states in the detail view
    step('summary.unavailable', !!document.querySelector('.summary-card .summary-unavailable')
      && document.querySelector('.summary-card').textContent.trim() === 'Summary unavailable'
      && !document.querySelector('.summary-heading')
      && !/timed out/.test(document.querySelector('#transcript-view').textContent), 'raw error must not leak');

    // Select the live recording (last item) -> full summary + 2 action items
    items[items.length - 1].click();
    await sleep(150);
    const sc = document.querySelector('.summary-card');
    const heads = Array.from(document.querySelectorAll('.summary-heading')).map((h) => h.textContent);
    const actionTexts = Array.from(document.querySelectorAll('.action-items li .action-text')).map((n) => n.textContent);
    step('summary.card', !!sc && heads.join('|') === 'Summary|Action Items'
      && /reviewed the mock recording pipeline/.test(sc.querySelector('.summary-text').textContent), heads.join('|'));
    step('summary.actionItems', actionTexts.length === 2 && document.querySelectorAll('.action-check').length === 2, actionTexts.join(' / '));
    step('summary.aboveTranscript', !!sc && sc.nextElementSibling && sc.nextElementSibling.classList.contains('transcript-text'));

    const liveRec = await window.api.recordings.get(state0(items[items.length - 1]));
    await window.api.transcript.copy(liveRec.id);
    const clip2 = await window.api.transcript.readClipboard();
    const expected = `SUMMARY:\n${liveRec.summary}\n\nACTION ITEMS:\n- ${liveRec.actionItems[0]}\n- ${liveRec.actionItems[1]}\n\nTRANSCRIPT:\n${liveRec.transcript}`;
    step('transcript.copy.withSummary', clip2 === expected, clip2.slice(0, 60));
    items[0].click();
    await sleep(100);

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
