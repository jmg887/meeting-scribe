/* MeetingScribe renderer — screens, recording, status, history, settings. */
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
    settings: { apiBaseUrl: '' },
    busy: false, // import/save in progress (not the pipeline itself)
  };

  const recorder = new WavRecorder({ onLevel: updateLevel });
  let timerInterval = null;

  // ------------------------------------------------------------ utils
  function formatDuration(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '--:--';
    const s = Math.floor(sec % 60);
    const m = Math.floor((sec / 60) % 60);
    const h = Math.floor(sec / 3600);
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function formatDate(ts) {
    try {
      return new Date(ts).toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
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

  const STATUS_LABEL = {
    saved: 'Saved',
    uploading: 'Uploading',
    transcribing: 'Transcribing',
    done: 'Done',
    error: 'Error',
  };

  const SOURCE_LABEL = { recording: 'Recorded', import: 'Imported' };

  let toastTimer = null;
  function toast(message, kind = '') {
    const el = $('#toast');
    el.textContent = message;
    el.className = `toast ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), kind === 'error' ? 6000 : 3000);
  }

  function showHomeError(message) {
    const el = $('#home-error');
    if (!message) {
      el.classList.add('hidden');
      el.textContent = '';
      return;
    }
    el.textContent = message;
    el.classList.remove('hidden');
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return node;
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

  // ------------------------------------------------------------ navigation
  function showScreen(name) {
    state.screen = name;
    $$('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
    $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.screen === name));
    if (name === 'history') renderHistory();
  }

  $$('.nav-btn').forEach((btn) => btn.addEventListener('click', () => showScreen(btn.dataset.screen)));

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
      timerEl.textContent = formatDuration(recorder.elapsedSeconds());
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
        $('#timer').textContent = formatDuration(durationSec);
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

  /** Imported mp3/m4a have no header duration; decode in the renderer to fill it in. */
  async function backfillDuration(rec) {
    if (Number.isFinite(rec.durationSec)) return;
    const d = await probeDuration(rec.filePath);
    if (Number.isFinite(d)) {
      const local = state.recordings.find((r) => r.id === rec.id);
      if (local) {
        local.durationSec = d;
        renderStatusCard();
        if (state.screen === 'history') renderHistory();
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
  // Prevent the window from navigating when a file is dropped elsewhere.
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
    $('#status-name').textContent = `${rec.originalName}${Number.isFinite(rec.durationSec) ? ` · ${formatDuration(rec.durationSec)}` : ''}`;
    const src = $('#status-source');
    src.textContent = SOURCE_LABEL[rec.source] || rec.source;
    src.className = `tag ${rec.source}`;

    const order = ['uploading', 'transcribing', 'done'];
    const currentIdx = rec.status === 'saved' ? -1 : order.indexOf(rec.status);
    $$('#status-card .steps li').forEach((li) => {
      const idx = order.indexOf(li.dataset.step);
      li.classList.remove('active', 'complete', 'failed');
      if (rec.status === 'error') {
        // Mark the step we failed on. Error after jobId => transcribing, else uploading.
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
    else if (rec.status === 'done') msg.textContent = rec.transcript ? `${rec.transcript.slice(0, 200)}${rec.transcript.length > 200 ? '…' : ''}` : 'Transcript is empty.';
    else msg.textContent = 'Saved locally.';

    $('#status-view-btn').classList.toggle('hidden', rec.status !== 'done');
    $('#status-retry-btn').classList.toggle('hidden', rec.status !== 'error');
  }

  $('#status-view-btn').addEventListener('click', () => {
    state.selectedId = state.activeId;
    showScreen('history');
  });
  $('#status-retry-btn').addEventListener('click', () => retry(state.activeId));

  async function retry(id) {
    try {
      const rec = await window.api.recordings.retry(id);
      upsertRecording(rec);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ------------------------------------------------------------ history
  function upsertRecording(rec) {
    const idx = state.recordings.findIndex((r) => r.id === rec.id);
    if (idx === -1) state.recordings.unshift(rec);
    else state.recordings[idx] = { ...state.recordings[idx], ...rec };
    state.recordings.sort((a, b) => b.createdAt - a.createdAt);
    updateBadge();
    if (rec.id === state.activeId) renderStatusCard();
    if (state.screen === 'history') renderHistory();
  }

  function updateBadge() {
    const active = state.recordings.filter((r) => r.status === 'uploading' || r.status === 'transcribing').length;
    const badge = $('#history-badge');
    badge.textContent = String(active);
    badge.classList.toggle('hidden', active === 0);
  }

  function renderHistory() {
    const list = $('#history-list');
    list.innerHTML = '';
    if (!state.recordings.length) {
      list.appendChild(el('div', { class: 'empty', text: 'No recordings yet.' }));
    }
    for (const rec of state.recordings) {
      const item = el('div', {
        class: `history-item${rec.id === state.selectedId ? ' selected' : ''}`,
        onclick: () => {
          state.selectedId = rec.id;
          renderHistory();
        },
      }, [
        el('div', { class: 'title', text: rec.originalName, title: rec.originalName }),
        el('div', { class: 'meta' }, [
          el('span', { text: formatDate(rec.createdAt) }),
          el('span', { text: `· ${formatDuration(rec.durationSec)}` }),
          el('span', { class: `tag ${rec.source}`, text: SOURCE_LABEL[rec.source] || rec.source }),
          el('span', { class: `tag status-${rec.status}`, text: STATUS_LABEL[rec.status] || rec.status }),
        ]),
      ]);
      list.appendChild(item);
    }
    renderTranscript();
  }

  function renderTranscript() {
    const view = $('#transcript-view');
    view.innerHTML = '';
    const rec = state.recordings.find((r) => r.id === state.selectedId);
    if (!rec) {
      view.appendChild(el('div', { class: 'empty', text: 'Select a recording to view its transcript.' }));
      return;
    }

    const hasTranscript = rec.status === 'done' && typeof rec.transcript === 'string';
    const actions = el('div', { class: 'transcript-actions' }, [
      el('button', {
        class: 'btn btn-secondary btn-small',
        text: 'Copy',
        disabled: hasTranscript ? undefined : 'true',
        onclick: async () => {
          try {
            await window.api.transcript.copy(rec.transcript);
            toast('Transcript copied to clipboard', 'success');
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }),
      el('button', {
        class: 'btn btn-secondary btn-small',
        text: 'Export .txt',
        disabled: hasTranscript ? undefined : 'true',
        onclick: async () => {
          try {
            const p = await window.api.transcript.export(rec.id);
            if (p) toast(`Saved to ${p}`, 'success');
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }),
      rec.status === 'error' || rec.status === 'saved'
        ? el('button', { class: 'btn btn-primary btn-small', text: 'Retry', onclick: () => retry(rec.id) })
        : null,
      el('button', {
        class: 'btn btn-secondary btn-small',
        text: 'Show file',
        onclick: () => window.api.app.showInFolder(rec.filePath),
      }),
      el('button', {
        class: 'btn btn-danger btn-small',
        text: 'Delete',
        onclick: async () => {
          if (!window.confirm(`Delete "${rec.originalName}" and its transcript? This cannot be undone.`)) return;
          try {
            await window.api.recordings.delete(rec.id);
            state.recordings = state.recordings.filter((r) => r.id !== rec.id);
            if (state.activeId === rec.id) state.activeId = null;
            state.selectedId = null;
            updateBadge();
            renderStatusCard();
            renderHistory();
            toast('Deleted');
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }),
    ].filter(Boolean));

    // Fix disabled attribute semantics: attribute "true"/undefined → boolean
    actions.querySelectorAll('button').forEach((b) => {
      if (b.getAttribute('disabled') === 'true') b.disabled = true;
      else b.removeAttribute('disabled');
    });

    const head = el('div', { class: 'transcript-head' }, [
      el('div', {}, [
        el('h2', { text: rec.originalName }),
        el('div', { class: 'muted small' }, [
          el('span', { text: `${formatDate(rec.createdAt)} · ${formatDuration(rec.durationSec)}${rec.sizeBytes ? ` · ${formatBytes(rec.sizeBytes)}` : ''} ` }),
          el('span', { class: `tag ${rec.source}`, text: SOURCE_LABEL[rec.source] || rec.source }),
          ' ',
          el('span', { class: `tag status-${rec.status}`, text: STATUS_LABEL[rec.status] || rec.status }),
        ]),
      ]),
      actions,
    ]);
    view.appendChild(head);

    if (hasTranscript) {
      view.appendChild(el('div', { class: 'transcript-text', text: rec.transcript || '(empty transcript)' }));
    } else if (rec.status === 'error') {
      view.appendChild(el('div', { class: 'alert alert-error', text: rec.error || 'Transcription failed.' }));
    } else {
      view.appendChild(el('div', { class: 'transcript-pending', text: `${STATUS_LABEL[rec.status] || rec.status}… the transcript will appear here when it is ready.` }));
    }
  }

  $('#open-folder-btn').addEventListener('click', () => window.api.app.openRecordingsFolder());

  // ------------------------------------------------------------ settings
  function renderBackendIndicator() {
    const ind = $('#backend-indicator');
    const label = ind.querySelector('.label');
    ind.classList.remove('ok', 'bad');
    if (!state.settings.apiBaseUrl) {
      label.textContent = 'No backend set';
    } else {
      label.textContent = state.settings.apiBaseUrl.replace(/^https?:\/\//, '');
      label.title = state.settings.apiBaseUrl;
    }
  }

  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#api-base-url');
    const value = input.value.trim();
    const status = $('#settings-status');
    if (value && !/^https?:\/\/.+/i.test(value)) {
      status.textContent = 'URL must start with http:// or https://';
      status.style.color = 'var(--danger)';
      return;
    }
    try {
      state.settings = await window.api.settings.update({ apiBaseUrl: value });
      input.value = state.settings.apiBaseUrl;
      status.textContent = 'Saved';
      status.style.color = 'var(--success)';
      renderBackendIndicator();
      toast('Settings saved', 'success');
    } catch (err) {
      status.textContent = err.message;
      status.style.color = 'var(--danger)';
    }
  });

  $('#test-connection-btn').addEventListener('click', async () => {
    const status = $('#settings-status');
    const url = $('#api-base-url').value.trim().replace(/\/+$/, '');
    if (!url) {
      status.textContent = 'Enter a URL first.';
      status.style.color = 'var(--danger)';
      return;
    }
    status.textContent = 'Testing…';
    status.style.color = '';
    const ind = $('#backend-indicator');
    try {
      const result = await window.api.backend.testConnection(url);
      if (result.reachable) {
        status.textContent = `Backend reachable (HTTP ${result.status})`;
        status.style.color = 'var(--success)';
        ind.classList.add('ok');
        ind.classList.remove('bad');
      } else {
        status.textContent = result.message;
        status.style.color = 'var(--danger)';
        ind.classList.add('bad');
        ind.classList.remove('ok');
      }
    } catch (err) {
      status.textContent = err.message;
      status.style.color = 'var(--danger)';
      ind.classList.add('bad');
      ind.classList.remove('ok');
    }
  });

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
      $('#data-dir').textContent = info.dataDir;
      $('#app-version').textContent = `v${info.version}`;
      renderBackendIndicator();
      updateBadge();

      // Resume showing the most recent in-flight/recent item on the home screen.
      if (recordings.length && (recordings[0].status === 'uploading' || recordings[0].status === 'transcribing')) {
        setActive(recordings[0].id);
      }
      if (!settings.apiBaseUrl) {
        showHomeError('No backend configured yet. Open Settings and enter the API base URL before recording or importing.');
      }
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
