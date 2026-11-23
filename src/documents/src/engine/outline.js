// Outline entries are a projection of source paragraphs, never additional text.
import { listMarkers } from './numbering.js';
// The OOXML levels 0–8 become user-facing levels 1–9; 9 is ordinary body text.
export const builtinOutlineLevel = id => /^Heading[1-9]$/.test(id || '') ? Number(id.slice(-1)) - 1 : null;

export function outlineEntries(paragraphs) {
  let start = 0;
  return paragraphs.flatMap(p => {
    const end = start + p.runs.reduce((n, r) => n + r.text.length, 0), level = p.format?.outlineLevel ?? 9;
    const entry = { id: p.id, start, end, level: level + 1,
      // A note reference, field or equation is an object character, which a heading's name does not show.
      text: p.runs.map(r => r.image ? r.image.alt || '[Image]' : r.math ? r.math.text || '' : r.text.replace(/\uFFFC/g, '')).join('').replace(/\s+/gu, ' ').trim() || '(Empty heading)' };
    // A heading in a table cell belongs to the table: it is listed, but the outline cannot move or delete it.
    if (p.cellId) entry.inTable = true;
    start = end + 1;
    return level < 9 ? [entry] : [];
  });
}

/**
 * The number each numbered heading shows ("2.1", "Chapter 3."), by paragraph id, as headings lists (the Navigation
 * pane, Go To, Cross-reference) show it before the heading's text, as the table of contents does. Bullets and
 * suppressed numbers have none. The numbers are counted once for the whole list, and only when a heading is in a list.
 */
export function headingNumbers(paragraphs, numbering) {
  const numbers = new Map();
  const heading = p => !p.cellId && (p.format?.outlineLevel ?? 9) < 9;
  if (!paragraphs.some(p => p.list && heading(p))) return numbers;
  let markers;
  try { markers = listMarkers(paragraphs, numbering); } catch { return numbers; }
  paragraphs.forEach((p, i) => {
    const marker = markers[i];
    if (heading(p) && marker?.text && !marker.suppressed && marker.level?.format !== 'bullet') numbers.set(p.id, marker.text.trim());
  });
  return numbers;
}
/** An outline entry's text with its heading number in front ("2.1 Methods"). */
export const numberedHeading = (entry, numbers) => numbers.has(entry.id) ? `${numbers.get(entry.id)} ${entry.text}` : entry.text;
