/**
 * Text to Columns: how one cell's text is cut into pieces, by separators or at fixed character positions.
 * Pure functions shared by the workbook (which writes the pieces) and the dialog (which previews them).
 *
 * Options: { mode: 'delimited' | 'fixed', delimiters: string[], consecutive: boolean, qualifier: '"' | "'" | '',
 *   breaks: number[] } — `breaks` are the character positions a fixed-width line is cut before (5 cuts "ab cde|fg").
 */

export const DEFAULT_SPLIT = Object.freeze({ mode: 'delimited', delimiters: [','], consecutive: false, qualifier: '"', breaks: [] });

/** The pieces of `text`, trimmed of the spaces around them as the old one-separator split did. */
export function splitPieces(text, options = DEFAULT_SPLIT) {
  const src = String(text ?? '');
  if (options.mode === 'fixed') {
    const cuts = [...new Set((options.breaks || []).filter((b) => Number.isInteger(b) && b > 0))].sort((a, b) => a - b);
    // A line shorter than a cut has nothing past its end: no empty pieces trail behind it.
    const starts = [0, ...cuts.filter((cut) => cut < src.length)];
    return starts.map((start, k) => src.slice(start, starts[k + 1] ?? src.length).trim());
  }
  const delims = new Set((options.delimiters || []).filter((d) => typeof d === 'string' && d.length === 1));
  if (!delims.size) return [src.trim()];
  const q = options.qualifier || '';
  const out = [];
  let field = '', i = 0, quoted = false, fresh = true;
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === q) {
        if (src[i + 1] === q) { field += q; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    // A qualifier opens a quoted piece only where the piece starts (spaces before it allowed).
    if (q && ch === q && field.trim() === '') { quoted = true; field = ''; fresh = false; i++; continue; }
    if (delims.has(ch)) {
      // Repeated separators count once: the empty pieces between them are dropped, as are leading ones.
      if (!(options.consecutive && field === '' && fresh)) out.push(field);
      field = ''; fresh = true; i++;
      if (options.consecutive) while (i < src.length && delims.has(src[i])) i++;
      continue;
    }
    field += ch; fresh = false; i++;
  }
  // With repeated separators counted once, one at the very end leaves no empty piece after it either.
  if (!(options.consecutive && field === '' && fresh && out.length)) out.push(field);
  return out.map((piece) => piece.trim());
}

/** The separator most of `texts` contain (tab, comma, semicolon, pipe, then space), or null. */
export function detectDelimiter(texts) {
  let best = null, bestCount = 0;
  for (const d of ['\t', ',', ';', '|', ' ']) {
    const count = texts.filter((t) => String(t).includes(d)).length;
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

/**
 * Cut positions for fixed-width text: each place where every line that reaches it has a space, and the
 * character after it on some line is not a space (the start of a column). Lines of one word suggest none.
 */
export function suggestBreaks(texts) {
  const lines = texts.map(String).filter((t) => t.length);
  if (!lines.length) return [];
  const width = Math.max(...lines.map((t) => t.length));
  const breaks = [];
  for (let p = 1; p < width; p++) {
    const blankBefore = lines.every((t) => p > t.length || t[p - 1] === ' ');
    const startsHere = lines.some((t) => t[p] && t[p] !== ' ');
    if (blankBefore && startsHere) breaks.push(p);
  }
  return breaks;
}
