// Manual hyphenation: find the next word that automatic hyphenation would split at a line end,
// so the user can confirm a break, which is then stored as a soft hyphen (U+00AD) in the text.
import { layoutDocument } from './layout.js';
import { pageGeometry } from './page-settings.js';
import { hyphenationPoints } from './hyphenation.js';

const LETTER = /[A-Za-z'’]/;

/** The plain word around a text position: { start, end, text } or null. */
export function wordAround(text, position) {
  let start = position, end = position;
  while (start > 0 && LETTER.test(text[start - 1])) start--;
  while (end < text.length && LETTER.test(text[end])) end++;
  while (start < end && /['’]/.test(text[start])) start++;
  while (end > start && /['’]/.test(text[end - 1])) end--;
  return end - start ? { start, end, text: text.slice(start, end) } : null;
}

/**
 * The first word at or after `from` that hyphenation would split in the body as it is laid out
 * now: { start, end, text, points, proposed }, where `points` are the word's break points and
 * `proposed` the one the line end calls for. Null when there is none. Hyphenation settings are
 * honoured (zone, capitals, suppressed paragraphs), with automatic hyphenation assumed on.
 */
export function nextHyphenationCandidate(editor, from = 0) {
  const body = editor.session.body, settings = body.pageSettings;
  const page = { ...pageGeometry(settings), autoHyphenation: true };
  const layout = layoutDocument(body.paragraphs, editor.measure, page, body.numbering, body.tables, editor.pageStories, { styles: body.styles, drawingLayouts: editor.drawingLayouts });
  const text = body.text, caps = !settings.doNotHyphenateCaps;
  const breaks = [...new Set(layout.lines.filter(line => line.autoHyphen).map(line => line.end))].sort((a, b) => a - b);
  for (const at of breaks) {
    const word = wordAround(text, at);
    if (!word || word.start < from) continue;
    const points = hyphenationPoints(word.text, { caps });
    const proposed = at - word.start;
    if (points.includes(proposed)) return { ...word, points, proposed };
  }
  return null;
}
