/**
 * The AI formula helper's pure parts: the prompt that describes the sheet
 * to the model, and reading a formula back out of its reply.
 */

import { colName, parseKey, cutText } from './cell.js';

/**
 * A short description of the sheet for the model: headers, tables, named
 * ranges, and the active cell. With `cells: false` the cells' contents (the
 * header row and the sample rows) stay out, and only the data's extent and
 * the names remain, for a prompt that quotes the cells it is about itself.
 */
export function describeSheet(wb, sheetId, active, { cells = true } = {}) {
  const lines = [];
  const used = dataBounds(wb, sheetId);
  const sheet = wb.sheet(sheetId);
  lines.push(`Active sheet: "${sheet.name}". Active cell: ${colName(active.c)}${active.r + 1}.`);
  if (used) {
    const headers = [];
    if (cells) {
      for (let c = used.c1; c <= Math.min(used.c2, used.c1 + 30); c++) {
        const text = wb.getDisplay(sheetId, used.r1, c);
        if (text) headers.push(`${colName(c)}${used.r1 + 1}="${cutText(text, 40)}"`);
      }
    }
    if (headers.length) lines.push(`First row of the data (likely headers): ${headers.join(', ')}.`);
    lines.push(`Data occupies ${colName(used.c1)}${used.r1 + 1}:${colName(used.c2)}${used.r2 + 1}.`);
    // A few sample rows so types are clear (sampleRange names them, so the dialog can say what is sent).
    const sample = cells ? sampleRange(wb, sheetId, used) : null;
    if (sample) {
      const samples = [];
      for (let r = sample.r1; r <= sample.r2; r++) {
        const cells = [];
        for (let c = sample.c1; c <= sample.c2; c++) cells.push(wb.getDisplay(sheetId, r, c) || '');
        samples.push(`Row ${r + 1}: ${cells.join(' | ')}`);
      }
      lines.push(samples.join('\n'));
    }
  }
  for (const t of wb.tablesOn?.(sheetId) || []) lines.push(`Table "${t.name}" with columns ${wb.tableColumns(sheetId, t).map((n) => `[${n}]`).join(', ')}; structured references like ${t.name}[${wb.tableColumns(sheetId, t)[0]}] work.`);
  // The names the Name Manager shows: not the hidden ones that keep a pivot table's or Solver's workings.
  const names = wb.namesForSheet(sheetId).filter((n) => !n.hidden);
  if (names.length) lines.push(`Named ranges: ${names.map((n) => `${n.name} = ${n.ref}`).join(', ')}.`);
  if (wb.sheets.length > 1) lines.push(`Other sheets: ${wb.sheets.filter((s) => s.id !== sheetId).map((s) => `"${s.name}"`).join(', ')}.`);
  return lines.join('\n');
}

/**
 * The cells describeSheet quotes as sample rows, values as shown: the three
 * rows under the data's first row, up to eleven columns wide. Null when the
 * data has no rows below its first. The dialog shows this as what is sent.
 */
export function sampleRange(wb, sheetId, used = dataBounds(wb, sheetId)) {
  if (!used || used.r2 <= used.r1) return null;
  return { r1: used.r1 + 1, c1: used.c1, r2: Math.min(used.r2, used.r1 + 3), c2: Math.min(used.c2, used.c1 + 10) };
}

/**
 * The block the sheet's data occupies: the used range without the blank rows
 * and columns before its first value or formula, so a table that starts at C2
 * is described from C2 (its header row) rather than from A1. Null when the
 * sheet is empty.
 */
export function dataBounds(wb, sheetId) {
  const used = wb.usedRange(sheetId);
  if (!used) return null;
  let r1 = used.r2;
  let c1 = used.c2;
  for (const [key, cell] of wb.sheet(sheetId).cells) {
    if (cell.v == null && cell.f == null) continue;
    const { r, c } = parseKey(key);
    if (r < r1) r1 = r;
    if (c < c1) c1 = c;
  }
  return { r1, c1, r2: used.r2, c2: used.c2 };
}

/**
 * The cells of a range as tab-separated text for the model (what is shown,
 * not formulas), capped at `maxRows` × `maxCols` with a note when cut.
 */
export function describeRange(wb, sheetId, range, { maxRows = 60, maxCols = 15 } = {}) {
  const r2 = Math.min(range.r2, range.r1 + maxRows - 1);
  const c2 = Math.min(range.c2, range.c1 + maxCols - 1);
  const lines = [];
  for (let r = range.r1; r <= r2; r++) {
    const cells = [];
    for (let c = range.c1; c <= c2; c++) cells.push(cutText(String(wb.getDisplay(sheetId, r, c) ?? '').replace(/\s+/g, ' '), 60));
    if (cells.some((t) => t !== '')) lines.push(`${r + 1}\t${cells.join('\t')}`);
  }
  const header = `\t${Array.from({ length: c2 - range.c1 + 1 }, (_, i) => colName(range.c1 + i)).join('\t')}`;
  const cut = [];
  if (r2 < range.r2) cut.push(`${range.r2 - r2} more rows`);
  if (c2 < range.c2) cut.push(`${range.c2 - c2} more columns`);
  return `Cells ${colName(range.c1)}${range.r1 + 1}:${colName(range.c2)}${range.r2 + 1} (row numbers first, columns tab-separated):\n${header}\n${lines.join('\n')}${cut.length ? `\n(${cut.join(' and ')} not shown)` : ''}`;
}

export function askPrompt(question, context, data) {
  return [
    'You answer questions about spreadsheet data for a non-expert. Use the data given; when you compute something, give the figure and say briefly how you got it. Plain language, at most a short paragraph or a few short lines; no headings, no code fences, no markdown.',
    'If the data cannot answer the question, say so in one sentence.',
    '',
    context,
    '',
    data,
    '',
    `Question: ${question}`,
  ].join('\n');
}

export function formulaPrompt(request, context) {
  return [
    'You write spreadsheet formulas (Excel and Google Sheets syntax; functions are uppercase, arguments separated by commas, decimals use a period).',
    'Reply with exactly one line containing only the formula, starting with =, and nothing else. No explanation, no code fences.',
    '',
    context,
    '',
    `Request: ${request}`,
  ].join('\n');
}

export function explainPrompt(formula, context) {
  return [
    'You explain spreadsheet formulas to a non-expert in two or three short sentences of plain language. No headings, no code fences, no bullet lists.',
    '',
    context,
    '',
    `Formula: =${formula}`,
  ].join('\n');
}

/** What carries a formula on past a closing parenthesis: an operator, or a range operator joined to a reference. "--" and dashes open prose. */
const CONTINUES_RE = /^\s*(?:(?!--)[-+*/^&=<>%]|:[A-Za-z$_(])/;
/** A hyphen set off by spaces and followed by two words in a row opens prose ("- returns yes"): no formula puts two names side by side. */
const DASH_PROSE_RE = /^\s+-\s+[A-Za-z]+\s+[A-Za-z]/;
/** Two words in a row after a space open prose as well ("doubles the value"), where a formula has no closing parenthesis to end at. */
const PROSE_RE = /^\s+[A-Za-z]+\s+[A-Za-z]/;
/** Where a quoted sheet name may begin: at the start of the formula or after an operator, a parenthesis or a comma. */
const REFERENCE_START_RE = /(?:^|[=(,+\-*/^&<>:])\s*$/;

/**
 * Where prose takes over from `line` at a space: the first space outside a string or a quoted
 * sheet name that two words in a row follow ("=A1*2 doubles the value"), or the end of the line.
 * An operator, a comma or a parenthesis after the word carries the formula on ("- tax * 2").
 */
function proseStart(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"') quote = ch;
    // An apostrophe opens a sheet name only where a reference can start; in prose ("cell's") it is part of a word.
    else if (ch === "'" && REFERENCE_START_RE.test(line.slice(0, i))) quote = ch;
    else if (/\s/.test(ch) && PROSE_RE.test(line.slice(i))) return i;
  }
  return line.length;
}

/**
 * Where the formula in `line` ends: at the first closing parenthesis that
 * balances it and is followed by prose, or at the end of the line. `depth`
 * is positive when the parentheses never close (the formula goes on).
 */
function formulaEnd(line) {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0 && i > 0) {
      const rest = line.slice(i + 1);
      if (rest && /^[\s.;:,]/.test(rest) && (!CONTINUES_RE.test(rest) || DASH_PROSE_RE.test(rest))) return { end: i + 1, depth };
    }
  }
  return { end: line.length, depth };
}

/** The formula in a model's reply: the first line that starts with = (joined with the lines that close its parentheses), with fences and trailing chatter stripped; null when there is none. */
export function extractFormula(reply) {
  const text = String(reply ?? '').replace(/```[a-z]*\n?/gi, '').trim();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let at = lines.findIndex((l) => l.startsWith('='));
  let line = at >= 0 ? lines[at] : null;
  if (!line) {
    // Inside prose: a function call, a formula in backticks, or an = at a word's start followed by
    // a reference, name or number expression, read to the next space (a string may hold spaces).
    const m = /(=\s*[A-Z][A-Z0-9_.]*\(.*\))/s.exec(text) || /`(=[^`]+)`/.exec(text)
      || /(?:^|[\s(])(=(?=[A-Za-z0-9$'"(+\-.@])(?:"[^"]*"|[^\s"])+)/.exec(text);
    line = m ? m[1].replace(/\s*\n\s*/g, '') : null;
  }
  if (!line) return null;
  line = line.replace(/^`+|`+$/g, '').replace(/^=\s+/, '=').trim();
  // A formula wrapped over several lines goes on until its parentheses close.
  while (at >= 0 && at + 1 < lines.length && formulaEnd(line).depth > 0) line += lines[++at].replace(/`+$/, '');
  // Trailing prose: cut where the formula ends, or where prose takes over at a space, and drop a
  // sentence's closing punctuation and a closing parenthesis that is the sentence's, not the formula's.
  const { end, depth } = formulaEnd(line);
  if (depth === 0) line = line.slice(0, Math.min(end, proseStart(line))).replace(/[.;:,]+$/, '');
  while (line.endsWith(')') && formulaEnd(line).depth < 0) line = line.slice(0, -1).replace(/[.;:,]+$/, '');
  return line.length > 1 ? line : null;
}
