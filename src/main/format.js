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
 *   - <item 1>
 *   - <item 2>
 *
 *   TRANSCRIPT:
 *   <transcript, verbatim>
 *
 * Without a summary the transcript is returned exactly as stored — no header
 * is added, so existing behaviour is unchanged for older records and for jobs
 * whose summary generation failed.
 */
function formatTranscriptExport(rec) {
  const transcript = typeof rec.transcript === 'string' ? rec.transcript : '';
  const summary = typeof rec.summary === 'string' && rec.summary.trim() ? rec.summary.trim() : null;
  if (!summary) return transcript;

  const items = Array.isArray(rec.actionItems)
    ? rec.actionItems.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
    : [];

  const parts = [`SUMMARY:\n${summary}`];
  if (items.length) parts.push(`ACTION ITEMS:\n${items.map((i) => `- ${i}`).join('\n')}`);
  parts.push(`TRANSCRIPT:\n${transcript}`);
  return parts.join('\n\n');
}

module.exports = { formatTranscriptExport };
