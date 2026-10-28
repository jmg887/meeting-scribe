/* MeetingScribe renderer — screens, recording, status, settings.
   The History screen (list, transcript reader, player) lives in history.js. */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ------------------------------------------------------------ state
  const state = {
    screen: 'home',
    recordings: [],
    selectedId: null,
    /** id of the recording currently shown in the home status card */
    activeId: null,
    settings: { apiBaseUrl: '', numSpeakers: null },
    busy: false, // import/save in progress (not the pipeline itself)
    /** history search query (matches title + transcript + summary) */
    query: '',
    /** find-in-transcript */
    find: { open: false, query: '', index: 0 },
    /** inline editors currently open, so re-renders don't clobber them */
    editing: { title: false, speaker: null },
  };

  const recorder = new WavRecorder({ onLevel: updateLevel });
  let timerInterval = null;

  // ------------------------------------------------------------ utils
  /** mm:ss or h:mm:ss; null when unknown (callers decide how to show "unknown"). */
  function formatDuration(sec) {
    if (!Number.isFinite(sec) || sec < 0) return null;
    const s = Math.floor(sec % 60);
    const m = Math.floor((sec / 60) % 60);
    const h = Math.floor(sec / 3600);
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function formatTime(ts, { withDate = true } = {}) {
    try {
      const d = new Date(ts);
      const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      if (!withDate) return time;
      return `${d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}, ${time}`;
    } catch (_) {
      return new Date(ts).toISOString();
    }
  }

  function formatBytes(n) {
    if (!Number.isFinite(n)) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  /** "Today" / "Yesterday" / "This week" / "This month" / "Earlier" bucket. */
  function dateGroup(ts) {
    const now = new Date();
    const d = new Date(ts);
    const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const today = startOfDay(now);
    const day = 24 * 60 * 60 * 1000;
    const t = startOfDay(d);
    if (t >= today) return 'Today';
    if (t >= today - day) return 'Yesterday';
    if (t >= today - 6 * day) return 'This week';
    if (t >= today - 30 * day) return 'This month';
    return 'Earlier';
  }

  const STATUS_LABEL = { saved: 'Saved', uploading: 'Uploading', transcribing: 'Transcribing', done: 'Done', error: 'Error' };
  const SOURCE_LABEL = { recording: 'Recorded', import: 'Imported' };
  const SOURCE_ICON = { recording: '#i-mic', import: '#i-file' };

  /** Display title: user-set title, else the original filename without extension. */
  function displayTitle(rec) {
    if (rec.title && rec.title.trim()) return rec.title.trim();
    return (rec.originalName || 'Recording').replace(/\.[^.]+$/, '');
  }

  let toastTimer = null;
  function toast(message, kind = '') {
    const node = $('#toast');
    node.textContent = message;
    node.className = `toast ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.add('hidden'), kind === 'error' ? 6000 : 3000);
  }

  function showHomeError(message) {
    const node = $('#home-error');
    if (!message) {
      node.classList.add('hidden');
      node.textContent = '';
      return;
    }
    node.textContent = message;
    node.classList.remove('hidden');
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'disabled' || k === 'checked') node[k] = Boolean(v);
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return node;
  }

  /** Inline SVG icon referencing the sprite in index.html. */
  function icon(id, cls = 'icon') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', id);
    svg.appendChild(use);
    return svg;
  }

  /** Try to read the duration of an audio file via the browser decoder. Returns null on failure. */
  async function probeDuration(filePath) {
    try {
      const buf = await window.api.files.read(filePath);
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      try {
        const decoded = await ctx.decodeAudioData(buf.slice(0));
        return decoded.duration;
      } finally {
        ctx.close();
      }
    } catch (_) {
      return null;
    }
  }

  /** Persist a metadata edit and merge the result into local state (no re-render). */
  async function saveMeta(id, patch) {
    const rec = await window.api.recordings.updateMeta(id, patch);
    upsertRecording(rec, { rerender: false });
    return rec;
  }

  // ------------------------------------------------------------ navigation
  function showScreen(name) {
    state.screen = name;
    $$('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
    $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.screen === name));
    if (name === 'history') history.renderHistory();
    else history.stopPlayer();
  }

  $$('.nav-btn, #backend-indicator').forEach((btn) => btn.addEventListener('click', () => showScreen(btn.dataset.screen)));

  // ------------------------------------------------------------ recording
  function updateLevel(rms) {
    const pct = Math.min(100, Math.round(rms * 400));
    $('#level-bar').style.width = `${pct}%`;
  }

  function startTimer() {
    const timerEl = $('#timer');
    timerEl.classList.add('active');
    timerEl.textContent = '00:00';
    timerInterval = setInterval(() => {
      timerEl.textContent = formatDuration(recorder.elapsedSeconds()) || '00:00';
    }, 250);
  }

  function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
    $('#timer').classList.remove('active');
    $('#level-bar').style.width = '0%';
  }

  function setRecordingUi(recording) {
    const btn = $('#record-btn');
    btn.classList.toggle('recording', recording);
    btn.querySelector('.record-label').textContent = recording ? 'Stop' : 'Record';
    btn.title = recording ? 'Stop recording' : 'Start recording';
    $('#import-btn').disabled = recording || state.busy;
  }

  async function toggleRecording() {
    showHomeError('');
    const btn = $('#record-btn');
    if (recorder.isRecording) {
      btn.disabled = true;
      try {
        const { buffer, durationSec } = await recorder.stop();
        stopTimer();
        setRecordingUi(false);
        $('#timer').textContent = formatDuration(durationSec) || '00:00';
        if (durationSec < 0.5) {
          showHomeError('That recording was too short to transcribe. Hold the button a little longer.');
          return;
        }
        state.busy = true;
        const rec = await window.api.recordings.saveWav(buffer, durationSec);
        upsertRecording(rec);
        setActive(rec.id);
        toast('Recording saved. Uploading…');
      } catch (err) {
        stopTimer();
        setRecordingUi(false);
        showHomeError(err.message);
      } finally {
        state.busy = false;
        btn.disabled = false;
        setRecordingUi(false);
      }
      return;
    }

    btn.disabled = true;
    try {
      const allowed = await window.api.app.requestMic();
      if (allowed === false) {
        throw new Error('Microphone access is blocked. Enable it for MeetingScribe in System Settings → Privacy & Security → Microphone.');
      }
      await recorder.start();
      setRecordingUi(true);
      startTimer();
    } catch (err) {
      showHomeError(err.message);
      setRecordingUi(false);
    } finally {
      btn.disabled = false;
    }
  }

  $('#record-btn').addEventListener('click', toggleRecording);

  // ------------------------------------------------------------ import
  async function importFile() {
    if (recorder.isRecording || state.busy) return;
    showHomeError('');
    state.busy = true;
    $('#import-btn').disabled = true;
    try {
      const rec = await window.api.recordings.import();
      if (!rec) return; // cancelled
      upsertRecording(rec);
      setActive(rec.id);
      toast('File imported. Uploading…');
      backfillDuration(rec);
    } catch (err) {
      showHomeError(err.message);
    } finally {
      state.busy = false;
      $('#import-btn').disabled = false;
    }
  }

  /** Non-WAV imports have no header we parse; decode in the renderer to fill in the duration. */
  async function backfillDuration(rec) {
    if (Number.isFinite(rec.durationSec)) return;
    const d = await probeDuration(rec.filePath);
    if (Number.isFinite(d)) {
      const local = state.recordings.find((r) => r.id === rec.id);
      if (local) {
        local.durationSec = d;
        renderStatusCard();
        if (state.screen === 'history') history.renderHistory();
      }
      window.api.recordings.setDuration(rec.id, d).catch(() => {});
    }
  }

  $('#import-btn').addEventListener('click', importFile);

  // Drag & drop onto the record panel
  const panel = $('.record-panel');
  ['dragenter', 'dragover'].forEach((ev) => panel.addEventListener(ev, (e) => {
    e.preventDefault();
    panel.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((ev) => panel.addEventListener(ev, (e) => {
    e.preventDefault();
    panel.classList.remove('dragover');
  }));
  panel.addEventListener('drop', async (e) => {
    if (recorder.isRecording || state.busy) return;
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    const filePath = window.api.files.pathFor(file);
    if (!filePath) {
      showHomeError('Could not read the dropped file. Use "Import Audio File" instead.');
      return;
    }
    showHomeError('');
    state.busy = true;
    try {
      const rec = await window.api.recordings.importPath(filePath);
      upsertRecording(rec);
      setActive(rec.id);
      toast('File imported. Uploading…');
      backfillDuration(rec);
    } catch (err) {
      showHomeError(err.message);
    } finally {
      state.busy = false;
    }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // ------------------------------------------------------------ status card
  function setActive(id) {
    state.activeId = id;
    renderStatusCard();
  }

  function renderStatusCard() {
    const card = $('#status-card');
    const rec = state.recordings.find((r) => r.id === state.activeId);
    if (!rec) {
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
    const dur = formatDuration(rec.durationSec);
    $('#status-name').textContent = `${displayTitle(rec)}${dur ? ` · ${dur}` : ''}`;
    $('#status-name').title = rec.originalName;
    $('#status-source-icon').querySelector('use').setAttribute('href', SOURCE_ICON[rec.source] || '#i-mic');

    const order = ['uploading', 'transcribing', 'done'];
    const currentIdx = rec.status === 'saved' ? -1 : order.indexOf(rec.status);
    $$('#status-card .steps li').forEach((li) => {
      const idx = order.indexOf(li.dataset.step);
      li.classList.remove('active', 'complete', 'failed');
      if (rec.status === 'error') {
        const failedStep = rec.jobId ? 'transcribing' : 'uploading';
        const failedIdx = order.indexOf(failedStep);
        if (idx < failedIdx) li.classList.add('complete');
        else if (idx === failedIdx) li.classList.add('failed');
      } else if (rec.status === 'done') {
        li.classList.add('complete');
      } else if (idx < currentIdx) {
        li.classList.add('complete');
      } else if (idx === currentIdx) {
        li.classList.add('active');
      }
    });

    const msg = $('#status-message');
    msg.classList.toggle('error', rec.status === 'error');
    if (rec.status === 'error') msg.textContent = rec.error || 'Something went wrong.';
    else if (rec.status === 'uploading') msg.textContent = 'Uploading audio to the backend…';
    else if (rec.status === 'transcribing') msg.textContent = 'Transcription in progress. This can take a while for long recordings — checking every few seconds.';
    else if (rec.status === 'done') {
      const preview = (rec.summary && rec.summary.trim()) || rec.transcript || '';
      msg.textContent = preview ? `${preview.slice(0, 200)}${preview.length > 200 ? '…' : ''}` : 'Transcript is empty.';
    } else msg.textContent = 'Saved locally.';

    $('#status-view-btn').classList.toggle('hidden', rec.status !== 'done');
    $('#status-retry-btn').classList.toggle('hidden', rec.status !== 'error');
  }

  $('#status-view-btn').addEventListener('click', () => {
    state.selectedId = state.activeId;
    showScreen('history');
  });
  $('#status-retry-btn').addEventListener('click', () => retry(state.activeId));
  $('#status-dismiss-btn').addEventListener('click', () => setActive(null));

  async function retry(id) {
    try {
      const rec = await window.api.recordings.retry(id);
      upsertRecording(rec);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ------------------------------------------------------------ shared record bookkeeping
  function upsertRecording(rec, { rerender = true } = {}) {
    const idx = state.recordings.findIndex((r) => r.id === rec.id);
    if (idx === -1) state.recordings.unshift(rec);
    else state.recordings[idx] = { ...state.recordings[idx], ...rec };
    state.recordings.sort((a, b) => b.createdAt - a.createdAt);
    updateBadge();
    if (!rerender) return;
    if (rec.id === state.activeId) renderStatusCard();
    if (state.screen === 'history') history.renderHistory();
  }

  function updateBadge() {
    const active = state.recordings.filter((r) => r.status === 'uploading' || r.status === 'transcribing').length;
    const badge = $('#history-badge');
    badge.textContent = String(active);
    badge.classList.toggle('hidden', active === 0);
  }

  // History module (history.js) receives the shared helpers it needs.
  const history = window.MeetingScribeHistory({
    state, el, icon, $, $$, toast, retry, upsertRecording, saveMeta, showScreen, updateBadge,
    formatDuration, formatTime, formatBytes, dateGroup, displayTitle,
    STATUS_LABEL, SOURCE_LABEL, SOURCE_ICON,
  });

  // ------------------------------------------------------------ settings (auto-save)
  function renderBackendIndicator(reach) {
    const ind = $('#backend-indicator');
    const label = ind.querySelector('.label');
    if (reach === true) { ind.classList.add('ok'); ind.classList.remove('bad'); }
    else if (reach === false) { ind.classList.add('bad'); ind.classList.remove('ok'); }
    if (!state.settings.apiBaseUrl) {
      ind.classList.remove('ok', 'bad');
      label.textContent = 'Not connected';
      ind.title = 'No backend configured — open Settings';
    } else {
      label.textContent = ind.classList.contains('bad') ? 'Backend unreachable' : ind.classList.contains('ok') ? 'Connected' : 'Backend set';
      ind.title = state.settings.apiBaseUrl;
    }
  }

  let savedTimer = null;
  function flashSaved(text = 'Saved') {
    const node = $('#settings-status');
    node.textContent = text;
    node.classList.add('show');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => node.classList.remove('show'), 1800);
  }

  function readNumSpeakersInput() {
    const input = $('#num-speakers');
    const raw = input.value.trim();
    input.classList.remove('invalid');
    if (raw === '') return { ok: true, value: null };
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(n)) {
      input.classList.add('invalid');
      return { ok: false, message: 'Expected number of speakers must be a whole number.' };
    }
    if (n < 1 || n > 20) {
      input.classList.add('invalid');
      return { ok: false, message: 'Expected number of speakers must be between 1 and 20 (or blank to auto-detect).' };
    }
    return { ok: true, value: n };
  }

  function setConnStatus(text, kind = '') {
    const node = $('#connection-status');
    node.textContent = text;
    node.className = `field-status ${kind}`;
  }

  async function saveSettings() {
    const input = $('#api-base-url');
    const value = input.value.trim();
    input.classList.remove('invalid');
    if (value && !/^https?:\/\/.+/i.test(value)) {
      input.classList.add('invalid');
      setConnStatus('URL must start with http:// or https://', 'bad');
      return false;
    }
    const speakers = readNumSpeakersInput();
    if (!speakers.ok) {
      flashSaved(speakers.message);
      return false;
    }
    const unchanged = value === (state.settings.apiBaseUrl || '') && speakers.value === (state.settings.numSpeakers ?? null);
    if (unchanged) return true;
    try {
      state.settings = await window.api.settings.update({ apiBaseUrl: value, numSpeakers: speakers.value });
      input.value = state.settings.apiBaseUrl;
      $('#num-speakers').value = state.settings.numSpeakers == null ? '' : String(state.settings.numSpeakers);
      renderBackendIndicator(null);
      if (state.settings.apiBaseUrl) showHomeError('');
      setConnStatus('');
      flashSaved('Saved');
      return true;
    } catch (err) {
      flashSaved(err.message);
      return false;
    }
  }

  // Auto-save on blur / Enter — never per keystroke, to avoid persisting half-typed URLs.
  ['#api-base-url', '#num-speakers'].forEach((sel) => {
    const input = $(sel);
    input.addEventListener('blur', saveSettings);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    });
  });
  $('#num-speakers').addEventListener('input', () => {
    const res = readNumSpeakersInput();
    if (!res.ok) flashSaved(res.message);
  });
  $('#settings-form').addEventListener('submit', (e) => { e.preventDefault(); saveSettings(); });

  $('#test-connection-btn').addEventListener('click', async () => {
    await saveSettings();
    const url = $('#api-base-url').value.trim().replace(/\/+$/, '');
    if (!url) {
      setConnStatus('Enter a URL first.', 'bad');
      return;
    }
    setConnStatus('Testing…');
    try {
      const result = await window.api.backend.testConnection(url);
      if (result.reachable) {
        setConnStatus(`Backend reachable (HTTP ${result.status})`, 'ok');
        renderBackendIndicator(true);
      } else {
        setConnStatus(result.message, 'bad');
        renderBackendIndicator(false);
      }
    } catch (err) {
      setConnStatus(err.message, 'bad');
      renderBackendIndicator(false);
    }
  });

  $('#open-folder-btn').addEventListener('click', () => window.api.app.openRecordingsFolder());

  // ------------------------------------------------------------ init
  async function init() {
    try {
      const [settings, recordings, info] = await Promise.all([
        window.api.settings.get(),
        window.api.recordings.list(),
        window.api.app.info(),
      ]);
      state.settings = settings;
      state.recordings = recordings;
      $('#api-base-url').value = settings.apiBaseUrl || '';
      $('#num-speakers').value = settings.numSpeakers == null ? '' : String(settings.numSpeakers);
      $('#data-dir').textContent = info.dataDir;
      $('#data-dir').title = info.dataDir;
      $('#app-version').textContent = `v${info.version}`;
      if (Array.isArray(info.supportedExtensions) && info.supportedExtensions.length) {
        $('#supported-formats').textContent = info.supportedExtensions.join(', ');
        $('#import-btn').title = `Import a ${info.supportedExtensions.join(', ')} file`;
      }
      renderBackendIndicator(null);
      updateBadge();

      if (recordings.length && (recordings[0].status === 'uploading' || recordings[0].status === 'transcribing')) {
        setActive(recordings[0].id);
      }
      if (!settings.apiBaseUrl) {
        showHomeError('No backend configured yet. Open Settings and enter the API base URL before recording or importing.');
      }
      // Fill in durations for older imports that were saved without one (fixes "--:--").
      for (const rec of recordings) if (!Number.isFinite(rec.durationSec) && rec.filePath) backfillDuration(rec);
    } catch (err) {
      toast(`Failed to load app data: ${err.message}`, 'error');
    }

    window.api.recordings.onProgress((rec) => {
      upsertRecording(rec);
      if (rec.status === 'done' && rec.id === state.activeId) toast('Transcription complete', 'success');
      if (rec.status === 'error' && rec.id === state.activeId) toast(rec.error || 'Transcription failed', 'error');
    });
  }

  init();
})();
