'use strict';

/**
 * Plain-text formatting shared by Copy and Export .txt.
 *
 * With a summary:
 *
 *   SUMMARY:
 *   <summary text>
 *
 *   ACTION ITEMS:          (only when there are action items)
 *   - [ ] <item 1>         (ticked items render as "- [x]")
 *   - [x] <item 2>
 *
 *   TRANSCRIPT:
 *   <transcript, with any speaker renames applied>
 *
 * Without a summary the transcript is returned on its own — no header is
 * added, so existing behaviour is unchanged for older records and for jobs
 * whose summary generation failed.
 */

/** Matches a diarised paragraph prefix such as "Speaker 3: ". */
const SPEAKER_PREFIX = /^(Speaker \d+):\s*/;

/**
 * Apply { "Speaker 1": "James" } renames to each paragraph's label.
 * Text is otherwise untouched; paragraphs without a label pass through.
 */
function applySpeakerNames(transcript, speakerNames) {
  const text = typeof transcript === 'string' ? transcript : '';
  if (!speakerNames || typeof speakerNames !== 'object' || !Object.keys(speakerNames).length) return text;
  return text
    .split(/\n\n/)
    .map((para) => {
      const m = para.match(SPEAKER_PREFIX);
      if (!m) return para;
      const name = speakerNames[m[1]];
      return name ? `${name}: ${para.slice(m[0].length)}` : para;
    })
    .join('\n\n');
}

function formatTranscriptExport(rec) {
  const transcript = applySpeakerNames(rec.transcript, rec.speakerNames);
  const summary = typeof rec.summary === 'string' && rec.summary.trim() ? rec.summary.trim() : null;
  if (!summary) return transcript;

  const items = Array.isArray(rec.actionItems)
    ? rec.actionItems.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean)
    : [];
  const checked = new Set(Array.isArray(rec.checkedActionItems) ? rec.checkedActionItems : []);

  const parts = [`SUMMARY:\n${summary}`];
  if (items.length) {
    const lines = items.map((item, i) => `- [${checked.has(i) ? 'x' : ' '}] ${item}`);
    parts.push(`ACTION ITEMS:\n${lines.join('\n')}`);
  }
  parts.push(`TRANSCRIPT:\n${transcript}`);
  return parts.join('\n\n');
}

module.exports = { formatTranscriptExport, applySpeakerNames, SPEAKER_PREFIX };
