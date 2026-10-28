/* Runs inside the renderer when MEETINGSCRIBE_SMOKE=1. Returns a promise resolving to a result object. */
(async () => {
  const log = (...a) => console.log('[smoke]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const result = { ok: false, steps: [] };
  const step = (name, ok, info) => { result.steps.push({ name, ok, info }); log(name, ok ? 'OK' : 'FAIL', info || ''); };
  const settle = async (id, tries = 60) => {
    let r = null;
    for (let i = 0; i < tries; i++) { await sleep(500); r = await window.api.recordings.get(id); if (!r || r.status === 'done' || r.status === 'error') break; }
    return r;
  };
  // Auto-save fires on blur; helper sets a field and blurs it.
  const setField = async (sel, value) => { const i = $(sel); i.focus(); i.value = value; i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); await sleep(250); };

  try {
    const baseUrl = window.__SMOKE_BASE_URL__ || 'http://127.0.0.1:8765';

    // ---------------------------------------------------------------- settings (auto-save)
    $('.nav-btn[data-screen="settings"]').click();
    step('ui.menuBarHidden', true, 'autoHideMenuBar set in main.js');
    step('ui.noDebugFooter', !document.body.textContent.includes('v33.') && !/\d+\.\d+\.\d+\.\d+:\d+/.test($('.sidebar').textContent), $('.sidebar-footer').textContent.trim());
    step('ui.settingsGroups', $$('.settings-group-title').map((h) => h.textContent).join('|') === 'Server|Transcription|Storage|About');
    step('ui.noSaveButton', !$$('#settings-form button').some((b) => /^save$/i.test(b.textContent.trim())));

    await setField('#api-base-url', baseUrl);
    const saved = await window.api.settings.get();
    step('settings.autosave', saved.apiBaseUrl === baseUrl, saved.apiBaseUrl);

    $('#test-connection-btn').click();
    await sleep(1500);
    step('settings.testConnection', /reachable/i.test($('#connection-status').textContent) && $('#backend-indicator').classList.contains('ok'), $('#connection-status').textContent);

    await setField('#num-speakers', '25');
    step('settings.numSpeakers.reject', (await window.api.settings.get()).numSpeakers === null && $('#num-speakers').classList.contains('invalid'));
    await setField('#num-speakers', '3');
    step('settings.numSpeakers.save', (await window.api.settings.get()).numSpeakers === 3);

    // ---------------------------------------------------------------- record
    $('.nav-btn[data-screen="home"]').click();
    step('ui.hintLegible', parseFloat(getComputedStyle($('.record-panel .hint')).fontSize) >= 13, getComputedStyle($('.record-panel .hint')).fontSize);
    $('#record-btn').click();
    await sleep(2200);
    step('record.start', $('#record-btn').classList.contains('recording') && $('#timer').textContent !== '00:00', $('#timer').textContent);
    $('#record-btn').click();

    let rec = null;
    for (let i = 0; i < 60; i++) { await sleep(500); rec = (await window.api.recordings.list())[0]; if (rec && (rec.status === 'done' || rec.status === 'error')) break; }
    step('record.pipeline', !!rec && rec.status === 'done', rec && (rec.status + ' ' + (rec.error || '')));
    step('record.numSpeakersSent', !!rec && /num_speakers=3/.test(rec.transcript || ''));
    step('record.duration', !!rec && rec.durationSec > 1.5 && rec.durationSec < 3.5, rec && rec.durationSec);
    step('record.wavSize', !!rec && rec.sizeBytes > 16000 * 2 * 1.5, rec && rec.sizeBytes);
    const stepsDone = $$('#status-card .steps li').every((li) => li.classList.contains('complete'));
    step('ui.statusSteps', stepsDone && !$('#status-card').classList.contains('hidden'));
    step('ui.statusPreviewIsSummary', /reviewed the mock recording pipeline/.test($('#status-message').textContent));
    $('#status-dismiss-btn').click();
    step('ui.statusDismiss', $('#status-card').classList.contains('hidden'));

    $('.nav-btn[data-screen="settings"]').click();
    await setField('#num-speakers', '');
    step('settings.numSpeakers.clear', (await window.api.settings.get()).numSpeakers === null);
    $('.nav-btn[data-screen="home"]').click();

    // ---------------------------------------------------------------- import
    let unsupportedMsg = '';
    try { await window.api.recordings.importPath(rec.filePath.replace(/\.wav$/, '.wma')); } catch (e) { unsupportedMsg = e.message; }
    step('import.unsupported', /Unsupported file type ".wma"/.test(unsupportedMsg) && /\.opus/.test(unsupportedMsg));
    step('ui.supportedFormats', $('#supported-formats').textContent === '.wav, .mp3, .m4a, .ogg, .flac, .aac, .opus');

    let noSumRec = null;
    if (window.__SMOKE_OGG_PATH__) {
      try { noSumRec = await window.api.recordings.importPath(window.__SMOKE_OGG_PATH__); } catch (e) { noSumRec = { error: e.message }; }
      step('import.oggAccepted', !!(noSumRec && noSumRec.id) && /\.ogg$/.test(noSumRec.originalName), noSumRec && (noSumRec.error || noSumRec.originalName));
      if (noSumRec && noSumRec.id) noSumRec = await settle(noSumRec.id);
    }
    const imported = await window.api.recordings.importPath(rec.filePath);
    const imp = await settle(imported.id);
    step('import.pipeline', imp && imp.status === 'done' && imp.source === 'import', imp && imp.status);
    step('import.numSpeakersOmitted', !!imp && /auto-detect/.test(imp.transcript || ''));

    // ---------------------------------------------------------------- history list
    $('.nav-btn[data-screen="history"]').click();
    await sleep(250);
    const items = $$('.history-item');
    const expectedItems = window.__SMOKE_OGG_PATH__ ? 3 : 2;
    step('history.list', items.length === expectedItems, items.length);
    step('history.dateGroup', $$('.history-group').length >= 1 && $('.history-group').textContent === 'Today', $$('.history-group').map((g) => g.textContent).join(','));
    step('history.noDoneChip', !$$('.history-item .tag').some((t) => /done/i.test(t.textContent)), $$('.history-item .tag').map((t) => t.textContent).join(',') || '(no chips)');
    step('history.sourceIcons', $$('.history-item .source-icon use').map((u) => u.getAttribute('href')).sort().join(',') === (expectedItems === 3 ? '#i-file,#i-file,#i-mic' : '#i-file,#i-mic'));
    step('history.titleNoExtension', !$$('.history-item .title').some((t) => /\.(wav|ogg)$/.test(t.textContent)));
    step('history.excerpt', $$('.history-item .excerpt').length >= 2 && /reviewed the mock/.test($('.history-item .excerpt').textContent));
    step('history.noUnknownDuration', !$('#history-list').textContent.includes('--:--'));

    // search
    const search = $('#history-search');
    search.value = 'nosummary'; search.dispatchEvent(new Event('input', { bubbles: true })); await sleep(50);
    step('history.search.match', $$('.history-item').length === (window.__SMOKE_OGG_PATH__ ? 1 : 0), $$('.history-item').length);
    search.value = 'zzzqqq'; search.dispatchEvent(new Event('input', { bubbles: true })); await sleep(50);
    step('history.search.empty', $$('.history-item').length === 0 && /No matches/.test($('#history-list').textContent));
    search.value = 'placeholder text'; search.dispatchEvent(new Event('input', { bubbles: true })); await sleep(50);
    step('history.search.transcriptBody', $$('.history-item').length === expectedItems, 'matches transcript text, not just title');
    $('#history-search-clear').click(); await sleep(50);
    step('history.search.clear', $$('.history-item').length === expectedItems && search.value === '');

    // ---------------------------------------------------------------- detail: live recording
    const live = $(`.history-item[data-id="${rec.id}"]`);
    live.click(); await sleep(200);
    step('detail.toolbar', $$('.transcript-toolbar .btn-group .btn').length === 3 && !!$('.transcript-toolbar .btn-quiet'));
    step('detail.titleEditable', !!$('.transcript-head h2') && !!$('.title-row .icon-btn'));

    // turns + chips
    const turns = $$('.transcript-text .turn');
    step('turns.count', turns.length === 3, turns.length);
    step('turns.chips', $$('.transcript-text .speaker-chip').map((c) => c.textContent).join(',') === 'S1,S2,S1');
    step('turns.distinctColors', turns[0].style.getPropertyValue('--chip') !== turns[1].style.getPropertyValue('--chip'));
    step('turns.innerNewline', /\n/.test(turns[2].querySelector('p').textContent));
    const measure = parseFloat(getComputedStyle($('.transcript-text')).fontSize);
    step('turns.readingSize', measure >= 15, measure);

    // speaker rename
    $$('.speaker-name')[0].click(); await sleep(50);
    const si = $('.speaker-input');
    step('rename.inputShown', !!si && si.value === 'Speaker 1');
    si.value = 'James'; si.blur(); await sleep(300);
    const afterRename = await window.api.recordings.get(rec.id);
    step('rename.persisted', afterRename.speakerNames['Speaker 1'] === 'James');
    step('rename.appliedToAllTurns', $$('.speaker-name').filter((n) => n.textContent.trim() === 'James').length === 2 && $$('.speaker-chip')[0].textContent === 'JA');
    await window.api.transcript.copy(rec.id);
    let clip = await window.api.transcript.readClipboard();
    step('rename.inCopy', /TRANSCRIPT:\nJames: \[mock transcript\]/.test(clip) && /\n\nSpeaker 2: /.test(clip));

    // title rename
    $('.transcript-head h2').click(); await sleep(50);
    const ti = $('.title-input');
    step('title.inputShown', !!ti);
    ti.value = 'Weekly sync'; ti.blur(); await sleep(300);
    step('title.persisted', (await window.api.recordings.get(rec.id)).title === 'Weekly sync');
    step('title.inList', $(`.history-item[data-id="${rec.id}"] .title`).textContent === 'Weekly sync' && $('.transcript-head h2').textContent === 'Weekly sync');

    // action item checkboxes
    const boxes = $$('.action-items input[type="checkbox"]');
    step('actions.checkboxes', boxes.length === 2 && boxes.every((b) => !b.checked));
    boxes[1].click(); await sleep(300);
    const afterTick = await window.api.recordings.get(rec.id);
    step('actions.tickPersisted', JSON.stringify(afterTick.checkedActionItems) === '[1]');
    step('actions.tickStyled', getComputedStyle($$('.action-text')[1]).textDecorationLine.includes('line-through'));
    await window.api.transcript.copy(rec.id);
    clip = await window.api.transcript.readClipboard();
    step('actions.tickInCopy', /ACTION ITEMS:\n- \[ \] Verify.+\n- \[x\] Confirm/.test(clip));

    // find in transcript
    $$('.transcript-toolbar .btn').find((b) => /find/i.test(b.textContent)).click(); await sleep(50);
    const fi = $('#find-bar input');
    fi.value = 'mock'; fi.dispatchEvent(new Event('input', { bubbles: true })); await sleep(50);
    const marks = $$('.transcript-text mark');
    step('find.highlights', marks.length >= 2 && $('#find-count').textContent === `1/${marks.length}`, $('#find-count').textContent);
    step('find.currentMark', $$('.transcript-text mark.current').length === 1);
    fi.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(50);
    step('find.step', $('#find-count').textContent === `2/${marks.length}`);
    fi.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(50);
    step('find.close', !$('#find-bar') && $$('.transcript-text mark').length === 0);

    // player
    const player = $('#player');
    step('player.present', !!player && !!player.querySelector('.play-btn') && !!player.querySelector('.scrub'));
    player.querySelector('.play-btn').click();
    await sleep(900);
    const playedSome = player.querySelector('.time').textContent !== '0:00' || !!player.querySelector('.play-btn use[href="#i-pause"]');
    step('player.plays', playedSome, player.querySelector('.time').textContent);
    player.querySelector('.play-btn').click(); await sleep(100);
    player.querySelector('.speed').click();
    step('player.speed', player.querySelector('.speed').textContent === '1.25×');

    // ---------------------------------------------------------------- detail: summary unavailable
    if (noSumRec && noSumRec.id) {
      $(`.history-item[data-id="${noSumRec.id}"]`).click(); await sleep(200);
      step('summary.unavailable', $('.summary-card') && $('.summary-card').textContent.trim() === 'Summary unavailable'
        && !/timed out/.test($('#transcript-view').textContent), 'raw error must not leak');
      await window.api.transcript.copy(noSumRec.id);
      clip = await window.api.transcript.readClipboard();
      step('copy.noSummaryPlain', clip === noSumRec.transcript && !clip.includes('SUMMARY:'));
    }

    // ---------------------------------------------------------------- error path + inline retry
    await window.api.settings.update({ apiBaseUrl: 'http://127.0.0.1:1' });
    await window.api.recordings.retry(imp.id);
    const failed = await settle(imp.id, 20);
    step('error.unreachable', failed && failed.status === 'error' && /refused|reach/i.test(failed.error), failed && failed.error);
    await sleep(250);
    const failedItem = $(`.history-item[data-id="${imp.id}"]`);
    step('error.chip', !!failedItem && /Failed/.test(failedItem.textContent));
    step('error.inlineRetry', !!failedItem && !!failedItem.querySelector('.btn') && /Retry/.test(failedItem.querySelector('.btn').textContent));
    step('error.excerptIsReason', /refused|reach/i.test(failedItem.querySelector('.excerpt').textContent));

    // ---------------------------------------------------------------- delete + empty state
    // Delete each recording through the UI (confirm() is auto-accepted below).
    window.confirm = () => true;
    for (const r of await window.api.recordings.list()) {
      const item = $(`.history-item[data-id="${r.id}"]`);
      if (!item) break;
      item.click(); await sleep(100);
      $('.transcript-toolbar .btn-quiet').click(); await sleep(250);
    }
    step('history.deleteAll', (await window.api.recordings.list()).length === 0);
    step('history.emptyState', !!$('.empty-state') && /No recordings yet/.test($('.empty-state').textContent) && !!$('.empty-state .btn'));
    $('.empty-state .btn').click(); await sleep(50);
    step('history.emptyStateCta', $('#screen-home').classList.contains('active'));

    result.ok = result.steps.every((s) => s.ok);
  } catch (err) {
    result.error = err.message + '\n' + err.stack;
    log('EXCEPTION', result.error);
  }
  return result;
})();
