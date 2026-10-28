/* MeetingScribe — History screen: searchable list, transcript reader, audio player.
   Loaded before app.js; app.js calls window.MeetingScribeHistory(deps). */
(function () {
  'use strict';

  window.MeetingScribeHistory = function createHistory(deps) {
    const {
      state, el, icon, $, $$, toast, retry, upsertRecording, saveMeta, showScreen,
      formatDuration, formatTime, formatBytes, dateGroup, displayTitle,
      STATUS_LABEL, SOURCE_LABEL, SOURCE_ICON,
    } = deps;

    const SPEAKER_RE = /^(Speaker \d+):\s*/;
    const SPEAKER_COLORS = 6;

    // ========================================================== search (list)
    const searchInput = $('#history-search');
    const searchClear = $('#history-search-clear');
    searchInput.addEventListener('input', () => {
      state.query = searchInput.value;
      searchClear.classList.toggle('hidden', !state.query);
      renderList();
    });
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      state.query = '';
      searchClear.classList.add('hidden');
      renderList();
      searchInput.focus();
    });

    function matchesQuery(rec, q) {
      if (!q) return true;
      const hay = [
        displayTitle(rec), rec.originalName, rec.transcript, rec.summary,
        ...(Array.isArray(rec.actionItems) ? rec.actionItems : []),
        ...Object.values(rec.speakerNames || {}),
      ].filter(Boolean).join('\n').toLowerCase();
      return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
    }

    /** Short text under the title: summary first, else transcript start; centred on the query hit. */
    function excerpt(rec, q) {
      const src = (rec.summary && rec.summary.trim()) || (rec.transcript || '').replace(SPEAKER_RE, '');
      if (!src) return '';
      if (q) {
        const word = q.toLowerCase().split(/\s+/).filter(Boolean)[0];
        const i = word ? src.toLowerCase().indexOf(word) : -1;
        if (i > 60) return `…${src.slice(i - 50, i + 110).replace(/\s+/g, ' ')}`;
      }
      return src.slice(0, 160).replace(/\s+/g, ' ');
    }

    // ========================================================== list
    function renderList() {
      const list = $('#history-list');
      list.innerHTML = '';
      const q = state.query.trim();
      const items = state.recordings.filter((r) => matchesQuery(r, q));

      if (!state.recordings.length) {
        list.appendChild(el('div', { class: 'empty-state' }, [
          icon('#i-mic', 'icon empty-icon'),
          el('h3', { text: 'No recordings yet' }),
          el('p', { text: 'Record a meeting or import an audio file and the transcript will appear here.' }),
          el('button', { class: 'btn btn-primary', text: 'Record your first meeting', onclick: () => showScreen('home') }),
        ]));
        return;
      }
      if (!items.length) {
        list.appendChild(el('div', { class: 'empty-state' }, [
          icon('#i-search', 'icon empty-icon'),
          el('h3', { text: 'No matches' }),
          el('p', { text: `Nothing in your titles or transcripts matches “${q}”.` }),
        ]));
        return;
      }

      let lastGroup = null;
      for (const rec of items) {
        const g = dateGroup(rec.createdAt);
        if (g !== lastGroup) {
          list.appendChild(el('div', { class: 'history-group', text: g }));
          lastGroup = g;
        }
        const inFlight = rec.status === 'uploading' || rec.status === 'transcribing';
        const dur = formatDuration(rec.durationSec);
        const meta = el('div', { class: 'meta' }, [
          el('span', { text: formatTime(rec.createdAt, { withDate: g === 'Earlier' || g === 'This month' }) }),
          dur ? el('span', { text: `· ${dur}` }) : null,
          // Status chip only when there is something to say. Done = no chip.
          inFlight ? el('span', { class: `tag status-${rec.status}`, text: STATUS_LABEL[rec.status] }) : null,
          rec.status === 'error' ? el('span', { class: 'tag status-error' }, [icon('#i-alert'), 'Failed']) : null,
          rec.status === 'error' || rec.status === 'saved'
            ? el('button', {
              class: 'btn btn-secondary btn-small', title: 'Retry upload and transcription',
              onclick: (e) => { e.stopPropagation(); retry(rec.id); },
            }, [icon('#i-refresh'), 'Retry'])
            : null,
        ]);
        const ex = rec.status === 'done' ? excerpt(rec, q) : (rec.status === 'error' ? (rec.error || '') : '');
        list.appendChild(el('div', {
          class: `history-item${rec.id === state.selectedId ? ' selected' : ''}`,
          'data-id': rec.id,
          onclick: () => select(rec.id),
        }, [
          icon(SOURCE_ICON[rec.source] || '#i-mic', 'icon source-icon'),
          el('div', { class: 'title', text: displayTitle(rec), title: `${SOURCE_LABEL[rec.source] || ''} · ${rec.originalName}` }),
          ex ? el('div', { class: 'excerpt', text: ex }) : null,
          meta,
        ]));
      }
    }

    function select(id) {
      if (state.selectedId !== id) {
        state.selectedId = id;
        state.find = { open: false, query: '', index: 0 };
        state.editing = { title: false, speaker: null };
        stopPlayer();
      }
      renderHistory();
    }

    function renderHistory() {
      renderList();
      renderDetail();
    }

    // ========================================================== transcript parsing
    /** Split stored transcript into [{ speaker: 'Speaker 1' | null, text }]. */
    function parseTurns(transcript) {
      const text = typeof transcript === 'string' ? transcript.replace(/\r\n?/g, '\n') : '';
      return text
        .split(/\n[ \t]*\n+/)
        .map((p) => p.replace(/^\n+|\n+$/g, ''))
        .filter(Boolean)
        .map((p) => {
          const m = p.match(SPEAKER_RE);
          return m ? { speaker: m[1], text: p.slice(m[0].length) } : { speaker: null, text: p };
        });
    }

    function speakerIndex(label) {
      const n = parseInt(String(label).replace(/\D/g, ''), 10);
      return Number.isFinite(n) && n > 0 ? ((n - 1) % SPEAKER_COLORS) + 1 : 1;
    }

    function speakerDisplay(rec, label) {
      return (rec.speakerNames && rec.speakerNames[label]) || label;
    }

    function initials(name) {
      if (/^Speaker \d+$/.test(name)) return `S${name.replace(/\D/g, '')}`;
      const words = name.trim().split(/\s+/);
      return words.length > 1 ? (words[0][0] + words[1][0]).toUpperCase() : name.slice(0, 2).toUpperCase();
    }

    // ========================================================== detail view
    function renderDetail() {
      const view = $('#transcript-view');
      view.innerHTML = '';
      const rec = state.recordings.find((r) => r.id === state.selectedId);
      if (!rec) {
        view.appendChild(el('div', { class: 'empty', text: 'Select a recording to view its transcript.' }));
        return;
      }
      const hasTranscript = rec.status === 'done' && typeof rec.transcript === 'string';

      view.appendChild(renderHead(rec, hasTranscript));

      if (hasTranscript) {
        const body = el('div', { class: 'transcript-body' });
        const summaryCard = renderSummaryCard(rec);
        if (summaryCard) body.appendChild(summaryCard);
        body.appendChild(renderTurns(rec));
        view.appendChild(body);
        if (state.find.open) applyFind();
      } else if (rec.status === 'error') {
        view.appendChild(el('div', { class: 'alert alert-error', text: rec.error || 'Transcription failed.' }));
        view.appendChild(el('div', { style: 'flex:1' }));
      } else {
        view.appendChild(el('div', { class: 'transcript-pending', text: `${STATUS_LABEL[rec.status] || rec.status}… the transcript will appear here when it is ready.` }));
        view.appendChild(el('div', { style: 'flex:1' }));
      }

      view.appendChild(renderPlayer(rec));
    }

    // ---------------------------------------------------------- header + toolbar
    function renderHead(rec, hasTranscript) {
      // Title — click to rename; Enter/blur saves, Esc cancels.
      let titleNode;
      if (state.editing.title) {
        titleNode = el('input', {
          class: 'title-input', type: 'text', value: displayTitle(rec), maxlength: '200', 'aria-label': 'Recording title',
          onkeydown: (e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
            if (e.key === 'Escape') { state.editing.title = false; renderDetail(); }
          },
          onblur: async (e) => {
            const value = e.target.value.trim();
            state.editing.title = false;
            try {
              // Saving text identical to the filename clears the override.
              const base = (rec.originalName || '').replace(/\.[^.]+$/, '');
              await saveMeta(rec.id, { title: value === base ? '' : value });
              renderHistory();
            } catch (err) { toast(err.message, 'error'); renderDetail(); }
          },
        });
        setTimeout(() => { titleNode.focus(); titleNode.select(); }, 0);
      } else {
        titleNode = el('h2', {
          text: displayTitle(rec), title: 'Click to rename',
          onclick: () => { state.editing.title = true; renderDetail(); },
        });
      }
      const titleRow = el('div', { class: 'title-row' }, [
        titleNode,
        state.editing.title ? null : el('button', {
          class: 'icon-btn', title: 'Rename', 'aria-label': 'Rename',
          onclick: () => { state.editing.title = true; renderDetail(); },
        }, [icon('#i-pencil')]),
      ]);

      const dur = formatDuration(rec.durationSec);
      const inFlight = rec.status === 'uploading' || rec.status === 'transcribing';
      const meta = el('div', { class: 'transcript-meta' }, [
        icon(SOURCE_ICON[rec.source] || '#i-mic', 'icon source-icon'),
        el('span', { text: `${SOURCE_LABEL[rec.source] || ''} · ${formatTime(rec.createdAt)}${dur ? ` · ${dur}` : ''}${rec.sizeBytes ? ` · ${formatBytes(rec.sizeBytes)}` : ''}` }),
        inFlight ? el('span', { class: `tag status-${rec.status}`, text: STATUS_LABEL[rec.status] }) : null,
        rec.status === 'error' ? el('span', { class: 'tag status-error' }, [icon('#i-alert'), 'Failed']) : null,
      ]);

      const group = el('div', { class: 'btn-group' }, [
        el('button', {
          class: 'btn btn-secondary btn-small', disabled: !hasTranscript, title: 'Copy summary and transcript',
          onclick: async () => {
            try {
              await window.api.transcript.copy(rec.id);
              toast(rec.summary ? 'Summary and transcript copied' : 'Transcript copied', 'success');
            } catch (err) { toast(err.message, 'error'); }
          },
        }, [icon('#i-copy'), 'Copy']),
        el('button', {
          class: 'btn btn-secondary btn-small', disabled: !hasTranscript, title: 'Export as .txt',
          onclick: async () => {
            try {
              const p = await window.api.transcript.export(rec.id);
              if (p) toast(`Saved to ${p}`, 'success');
            } catch (err) { toast(err.message, 'error'); }
          },
        }, [icon('#i-download'), 'Export']),
        el('button', {
          class: 'btn btn-secondary btn-small', title: 'Show the audio file in your file manager',
          onclick: () => window.api.app.showInFolder(rec.filePath),
        }, [icon('#i-folder'), 'Show file']),
      ]);

      const toolbar = el('div', { class: 'transcript-toolbar' }, [
        group,
        (rec.status === 'error' || rec.status === 'saved')
          ? el('button', { class: 'btn btn-primary btn-small', onclick: () => retry(rec.id) }, [icon('#i-refresh'), 'Retry'])
          : null,
        hasTranscript ? (state.find.open ? renderFindBar() : el('button', {
          class: 'btn btn-secondary btn-small', title: 'Find in transcript (Ctrl+F)',
          onclick: () => { state.find.open = true; renderDetail(); },
        }, [icon('#i-search'), 'Find'])) : null,
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'btn btn-quiet btn-small', title: 'Delete recording and transcript',
          onclick: async () => {
            if (!window.confirm(`Delete "${displayTitle(rec)}" and its transcript? This cannot be undone.`)) return;
            try {
              stopPlayer();
              await window.api.recordings.delete(rec.id);
              state.recordings = state.recordings.filter((r) => r.id !== rec.id);
              if (state.activeId === rec.id) state.activeId = null;
              state.selectedId = null;
              deps.updateBadge();
              renderHistory();
              toast('Deleted');
            } catch (err) { toast(err.message, 'error'); }
          },
        }, [icon('#i-trash'), 'Delete']),
      ]);

      return el('div', { class: 'transcript-head' }, [titleRow, meta, toolbar]);
    }

    // ---------------------------------------------------------- find in transcript
    function renderFindBar() {
      const input = el('input', {
        type: 'search', placeholder: 'Find in transcript', value: state.find.query, 'aria-label': 'Find in transcript',
        oninput: (e) => { state.find.query = e.target.value; state.find.index = 0; applyFind(); },
        onkeydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
          if (e.key === 'Escape') closeFind();
        },
      });
      setTimeout(() => input.focus(), 0);
      return el('div', { class: 'find-bar', id: 'find-bar' }, [
        icon('#i-search'),
        input,
        el('span', { class: 'find-count', id: 'find-count', text: '' }),
        el('button', { class: 'icon-btn', title: 'Previous (Shift+Enter)', onclick: () => stepFind(-1) }, [icon('#i-chev-up')]),
        el('button', { class: 'icon-btn', title: 'Next (Enter)', onclick: () => stepFind(1) }, [icon('#i-chev-down')]),
        el('button', { class: 'icon-btn', title: 'Close (Esc)', onclick: closeFind }, [icon('#i-x')]),
      ]);
    }

    function closeFind() {
      state.find = { open: false, query: '', index: 0 };
      renderDetail();
    }

    function stepFind(dir) {
      const marks = $$('.transcript-text mark');
      if (!marks.length) return;
      state.find.index = (state.find.index + dir + marks.length) % marks.length;
      highlightCurrent(marks);
    }

    function highlightCurrent(marks) {
      marks.forEach((m, i) => m.classList.toggle('current', i === state.find.index));
      const cur = marks[state.find.index];
      if (cur) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const count = $('#find-count');
      if (count) count.textContent = marks.length ? `${state.find.index + 1}/${marks.length}` : (state.find.query ? '0/0' : '');
    }

    /** Re-highlight every turn paragraph for the current query. Text nodes only — never innerHTML. */
    function applyFind() {
      const q = state.find.query.trim().toLowerCase();
      $$('.transcript-text .turn p').forEach((p) => {
        const raw = p.dataset.text;
        p.textContent = '';
        if (!q) { p.appendChild(document.createTextNode(raw)); return; }
        const lower = raw.toLowerCase();
        let i = 0;
        for (;;) {
          const j = lower.indexOf(q, i);
          if (j === -1) { p.appendChild(document.createTextNode(raw.slice(i))); break; }
          if (j > i) p.appendChild(document.createTextNode(raw.slice(i, j)));
          p.appendChild(el('mark', { text: raw.slice(j, j + q.length) }));
          i = j + q.length;
        }
      });
      const marks = $$('.transcript-text mark');
      if (state.find.index >= marks.length) state.find.index = 0;
      highlightCurrent(marks);
    }

    document.addEventListener('keydown', (e) => {
      const isFind = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f';
      if (!isFind || state.screen !== 'history') return;
      const rec = state.recordings.find((r) => r.id === state.selectedId);
      if (!rec || rec.status !== 'done') return;
      e.preventDefault();
      if (!state.find.open) { state.find.open = true; renderDetail(); }
      else { const i = $('#find-bar input'); if (i) { i.focus(); i.select(); } }
    });

    // ---------------------------------------------------------- summary card
    function renderSummaryCard(rec) {
      const summary = typeof rec.summary === 'string' && rec.summary.trim() ? rec.summary.trim() : null;
      const summaryError = typeof rec.summaryError === 'string' && rec.summaryError.trim() ? rec.summaryError : null;
      if (!summary && !summaryError) return null;

      const card = el('section', { class: 'card summary-card', 'aria-label': 'Summary' });
      if (!summary) {
        card.appendChild(el('div', { class: 'summary-unavailable muted small', text: 'Summary unavailable' }));
        return card;
      }
      card.appendChild(el('h3', { class: 'summary-heading', text: 'Summary' }));
      card.appendChild(el('p', { class: 'summary-text', text: summary }));

      const items = Array.isArray(rec.actionItems) ? rec.actionItems : [];
      const visible = items.map((s, i) => ({ s: typeof s === 'string' ? s.trim() : '', i })).filter((x) => x.s);
      if (visible.length) {
        const checked = new Set(Array.isArray(rec.checkedActionItems) ? rec.checkedActionItems : []);
        card.appendChild(el('h3', { class: 'summary-heading', text: 'Action Items' }));
        const list = el('ul', { class: 'action-items' });
        for (const { s, i } of visible) {
          const box = el('input', {
            type: 'checkbox', checked: checked.has(i), 'data-index': String(i),
            onchange: async (e) => {
              const next = new Set(checked);
              if (e.target.checked) next.add(i); else next.delete(i);
              try {
                await saveMeta(rec.id, { checkedActionItems: [...next] });
                checked.clear(); next.forEach((v) => checked.add(v));
              } catch (err) { toast(err.message, 'error'); e.target.checked = !e.target.checked; }
            },
          });
          list.appendChild(el('li', {}, [
            el('label', {}, [box, el('span', { class: 'action-check' }, [icon('#i-check')]), el('span', { class: 'action-text', text: s })]),
          ]));
        }
        card.appendChild(list);
      }
      return card;
    }

    // ---------------------------------------------------------- transcript turns
    function renderTurns(rec) {
      const container = el('div', { class: 'transcript-text' });
      const turns = parseTurns(rec.transcript);
      if (!turns.length) {
        container.appendChild(el('p', { class: 'muted', text: '(empty transcript)' }));
        return container;
      }
      const hasSpeakers = turns.some((t) => t.speaker);
      if (hasSpeakers && !Object.keys(rec.speakerNames || {}).length) {
        container.appendChild(el('p', { class: 'speaker-hint', text: 'Tip: click a speaker name to rename it everywhere in this transcript.' }));
      }
      let inputMounted = false;
      for (const t of turns) {
        if (!t.speaker) {
          container.appendChild(el('div', { class: 'turn plain' }, [el('p', { text: t.text, 'data-text': t.text })]));
          continue;
        }
        const name = speakerDisplay(rec, t.speaker);
        const idx = speakerIndex(t.speaker);
        let nameNode;
        if (state.editing.speaker === t.speaker && !inputMounted) {
          nameNode = renderSpeakerInput(rec, t.speaker, name);
          inputMounted = true;
        } else {
          nameNode = el('button', {
            class: 'speaker-name', title: `Rename ${t.speaker}`,
            onclick: () => { state.editing.speaker = t.speaker; renderDetail(); },
          }, [name, icon('#i-pencil')]);
        }
        container.appendChild(el('div', { class: 'turn', style: `--chip: var(--speaker-${idx})` }, [
          el('span', { class: 'speaker-chip', text: initials(name), title: name }),
          el('div', {}, [el('div', { class: 'turn-head' }, [nameNode]), el('p', { text: t.text, 'data-text': t.text })]),
        ]));
      }
      return container;
    }

    function renderSpeakerInput(rec, label, current) {
      const input = el('input', {
        class: 'speaker-input', type: 'text', value: current, maxlength: '80', 'aria-label': `Name for ${label}`,
        onkeydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
          if (e.key === 'Escape') { state.editing.speaker = null; renderDetail(); }
        },
        onblur: async (e) => {
          const value = e.target.value.trim();
          state.editing.speaker = null;
          try {
            const names = { ...(rec.speakerNames || {}) };
            if (!value || value === label) delete names[label]; else names[label] = value;
            await saveMeta(rec.id, { speakerNames: names });
            renderHistory();
          } catch (err) { toast(err.message, 'error'); renderDetail(); }
        },
      });
      setTimeout(() => { input.focus(); input.select(); }, 0);
      return input;
    }

    // ========================================================== audio player
    const audio = new Audio();
    audio.preload = 'metadata';
    let playerRecId = null;
    let objectUrl = null;
    const SPEEDS = [1, 1.25, 1.5, 2];
    let speedIdx = 0;

    function stopPlayer() {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
      playerRecId = null;
    }

    async function loadAudio(rec) {
      if (playerRecId === rec.id && audio.src) return true;
      stopPlayer();
      try {
        const buf = await window.api.files.read(rec.filePath);
        const ext = (rec.filePath.split('.').pop() || '').toLowerCase();
        const mime = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/ogg' }[ext] || 'audio/*';
        objectUrl = URL.createObjectURL(new Blob([buf], { type: mime }));
        audio.src = objectUrl;
        audio.playbackRate = SPEEDS[speedIdx];
        playerRecId = rec.id;
        return true;
      } catch (_) {
        return false;
      }
    }

    function renderPlayer(rec) {
      if (!rec.filePath) return el('div', { class: 'player unavailable', text: 'Audio file not available' });

      const playBtn = el('button', { class: 'icon-btn play-btn', title: 'Play / pause (Space)', 'aria-label': 'Play' }, [icon('#i-play')]);
      const cur = el('span', { class: 'time', text: '0:00' });
      const total = el('span', { class: 'time', text: formatDuration(rec.durationSec) || '–:––' });
      const scrub = el('input', { class: 'scrub', type: 'range', min: '0', max: '1000', value: '0', 'aria-label': 'Seek' });
      const speed = el('button', { class: 'speed', title: 'Playback speed', text: `${SPEEDS[speedIdx]}×` });

      const setPlayIcon = () => {
        playBtn.innerHTML = '';
        playBtn.appendChild(icon(audio.paused ? '#i-play' : '#i-pause'));
        playBtn.setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
      };
      const sync = () => {
        if (playerRecId !== rec.id) return;
        const d = Number.isFinite(audio.duration) ? audio.duration : rec.durationSec;
        cur.textContent = formatDuration(audio.currentTime) || '0:00';
        if (Number.isFinite(d) && d > 0) {
          total.textContent = formatDuration(d);
          if (!scrub.matches(':active')) scrub.value = String(Math.round((audio.currentTime / d) * 1000));
        }
        setPlayIcon();
      };

      playBtn.addEventListener('click', async () => {
        const ok = await loadAudio(rec);
        if (!ok) { toast('Could not open the audio file.', 'error'); return; }
        if (audio.paused) {
          try { await audio.play(); } catch (err) { toast(`Playback failed: ${err.message}`, 'error'); }
        } else audio.pause();
        setPlayIcon();
      });
      scrub.addEventListener('input', async () => {
        const ok = await loadAudio(rec);
        if (!ok) return;
        const d = Number.isFinite(audio.duration) ? audio.duration : rec.durationSec;
        if (Number.isFinite(d)) audio.currentTime = (Number(scrub.value) / 1000) * d;
      });
      speed.addEventListener('click', () => {
        speedIdx = (speedIdx + 1) % SPEEDS.length;
        audio.playbackRate = SPEEDS[speedIdx];
        speed.textContent = `${SPEEDS[speedIdx]}×`;
      });
      const skip = (s) => async () => {
        const ok = await loadAudio(rec);
        if (!ok) return;
        audio.currentTime = Math.max(0, Math.min((audio.duration || rec.durationSec || 0), audio.currentTime + s));
        sync();
      };

      ['timeupdate', 'play', 'pause', 'ended', 'loadedmetadata', 'durationchange'].forEach((ev) => audio.addEventListener(ev, sync));
      // The decoder's duration is authoritative; persist it if the record has none (fixes "--:--").
      audio.addEventListener('loadedmetadata', () => {
        if (playerRecId === rec.id && !Number.isFinite(rec.durationSec) && Number.isFinite(audio.duration)) {
          window.api.recordings.setDuration(rec.id, audio.duration).then((r) => upsertRecording(r)).catch(() => {});
        }
      }, { once: true });
      sync();

      return el('div', { class: 'player', id: 'player' }, [
        el('button', { class: 'icon-btn', title: 'Back 10 seconds', onclick: skip(-10) }, [icon('#i-back10')]),
        playBtn,
        el('button', { class: 'icon-btn', title: 'Forward 10 seconds', onclick: skip(10) }, [icon('#i-fwd10')]),
        cur, scrub, total, speed,
      ]);
    }

    // Space toggles playback when focus isn't in a text field or button.
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || state.screen !== 'history') return;
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (/INPUT|TEXTAREA|BUTTON/.test(tag)) return;
      const btn = $('#player .play-btn');
      if (btn) { e.preventDefault(); btn.click(); }
    });

    return { renderHistory, renderList, renderDetail, stopPlayer, parseTurns };
  };
})();
