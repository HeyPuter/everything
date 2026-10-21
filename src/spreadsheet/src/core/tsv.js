/**
 * Tab-separated text for the clipboard, and CSV parsing for pasted text.
 * Quoting follows the spreadsheet convention: a field containing the
 * delimiter, a quote, or a newline is wrapped in double quotes, with inner
 * quotes doubled.
 */

import { getLocale, localeInfo, parseInput } from './format.js';

export function toDelimited(rows, delim = '\t') {
  return rows.map((row) => row.map((cell) => {
    const s = cell == null ? '' : String(cell);
    return /["\r\n]/.test(s) || s.includes(delim) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(delim)).join('\n');
}

// Optional bounds let a parallel clipboard representation be checked against
// an already-known table without allocating an unrelated, oversized matrix.
export function parseDelimited(text, delim, { maxRows = Infinity, maxColumns = Infinity, strict = false } = {}) {
  if (text == null) return [];
  const src = String(text);
  if (src === '') return [];
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  let rowStart = 0;
  while (i < src.length) {
    if (rows.length >= maxRows || row.length >= maxColumns) return null;
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        if (strict && i + 1 < src.length && ![delim, '\r', '\n'].includes(src[i + 1])) return null;
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    // A quote inside an unquoted field is part of it, strict or not: Excel quotes only a cell holding a
    // line break or a tab, so a cell reading 12" pipe comes as it is.
    if (ch === '"' && field === '') { quoted = true; i++; continue; }
    if (ch === delim) { row.push(field); field = ''; i++; continue; }
    if (ch === '\n' || ch === '\r') {
      row.push(field); rows.push(row); row = []; field = '';
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
      rowStart = i;
      continue;
    }
    field += ch;
    i++;
  }
  // A trailing newline ends the last row rather than opening an empty one.
  if (strict && quoted) return null;
  if (rowStart < src.length) {
    if (rows.length >= maxRows || row.length >= maxColumns) return null;
    row.push(field); rows.push(row);
  }
  return rows;
}

/**
 * Do the commas of CSV-shaped text plainly mean something other than a column
 * break? Every one groups thousands (a digit before, exactly three after:
 * "1,234"), every one is followed by a space as in prose ("Smith, John"), or
 * every line reads as one number or amount ("$1,234.50").
 */
function commasAreNotSeparators(src) {
  if (!/(?<!\d),|,(?!\d{3}(?!\d))/.test(src) || !/,(?! )/.test(src)) return true;
  return src.split(/\r\n|\r|\n/).every((line) => line.trim() === '' || typeof parseInput(line).v === 'number');
}

/** Clipboard text: tabs when present, otherwise treat it as CSV. */
export function parseClipboard(text) {
  const src = String(text ?? '');
  if (src.includes('\t')) return parseDelimited(src, '\t');
  // Plain text splits on tabs. A block of lines that
  // all carry the same number of commas is a CSV table and splits too, unless
  // commas are this locale's decimal mark ("1,5" is a number, not two cells)
  // or read as thousands separators or prose throughout.
  if (src.includes(',') && localeInfo(getLocale()).decimal !== ',') {
    const rows = parseDelimited(src, ',').filter((row) => row.some((cell) => cell.trim() !== ''));
    if (rows.length >= 2 && rows[0].length >= 2 && rows.every((row) => row.length === rows[0].length) && !commasAreNotSeparators(src)) return parseDelimited(src, ',');
  }
  return parseDelimited(src, '\t');
}
