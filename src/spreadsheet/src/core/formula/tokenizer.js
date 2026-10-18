/**
 * Formula tokenizer. Turns the text after "=" into a flat token list the
 * parser and the reference rewriters (copy/paste, insert/delete) share, so
 * the two can never disagree about where a reference starts and ends.
 *
 * Token kinds:
 *   number   { value }
 *   string   { value }            (double-quoted, "" escapes a quote)
 *   bool     { value }
 *   error    { value }            (#DIV/0!, #N/A, ...)
 *   ref      { text, sheet?, sheetEnd?, spill } (A1, $A$1, A1:B2, A:A, 1:1, Sheet1!A1, Sheet1:Sheet3!A1; spill: A1#)
 *   name     { value, sheet? }    (function or defined name; sheet for Sheet!Name)
 *   tref     { table, spec }      (structured reference Table1[Amount]; table null for a bare [@Col])
 *   op       { value }            (+ - * / ^ & = <> < > <= >= % and @ for implicit intersection)
 *   lparen | rparen | comma | colon
 *   lbrace | rbrace                (array constants: {1,2;3,4})
 *   comma carries { value } — ',' or ';' — so array rows can be told apart
 */

import { parseDecimal } from './number-text.js';

const ERRORS = ['#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#N/A', '#NUM!', '#NULL!', '#CYCLE!', '#SPILL!', '#CALC!'];

// A single endpoint: optional $, letters, optional $, digits — or a whole
// column (A) / whole row (1) when paired with a colon.
const CELL = String.raw`\$?[A-Za-z]{1,3}\$?\d{1,7}`;
const COL_ONLY = String.raw`\$?[A-Za-z]{1,3}`;
const ROW_ONLY = String.raw`\$?\d{1,7}`;
const CELL_RE = new RegExp(`^${CELL}$`);
const REF_BODY = String.raw`(?:${CELL}(?::${CELL})?|${COL_ONLY}:${COL_ONLY}|${ROW_ONLY}:${ROW_ONLY})`;
// An unquoted sheet or defined name: a letter in any script, an underscore or a backslash, then
// letters, combining marks (the vowel signs of हिन्दी, the accents of a decomposed Ünïcode), digits,
// underscores, periods, backslashes and question marks, as a defined name may hold; workbook
// files write Übersicht!A1 and シート1!A1 without quotes.
const IDENT = String.raw`[\p{L}_\\][\p{L}\p{M}\p{N}_.\\?]*`;
const SHEET_NAME = String.raw`(?:'(?:[^']|'')+'|${IDENT})`;
// Sheet1!A1, or a 3D span Sheet1:Sheet3!A1 (every sheet between the two, in tab order); #REF!A1 is
// how a file writes a reference to a sheet that has been deleted.
const SHEET = String.raw`(?:${SHEET_NAME}(?::${SHEET_NAME})?!|#REF!)`;
const REF_RE = new RegExp(String.raw`^(${SHEET})?(${REF_BODY})(?![\p{L}\p{M}\p{N}_(!])`, 'u');
// [1]Sheet1!A1 reaches into another workbook (a workbook file numbers the files it links to).
const EXTERNAL_RE = new RegExp(String.raw`^\[[^\[\]]+\](?=${SHEET})`, 'u');
const NUMBER_RE = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const NAME_RE = new RegExp(`^${IDENT}`, 'u');
const BOOK_NAME_RE = new RegExp(String.raw`^(\[[^\[\]]+\])!(${IDENT})`, 'u');
const SCOPED_NAME_RE = new RegExp(`^(${SHEET_NAME})!(${IDENT})`, 'u');
const SPAN_RE = new RegExp(`^(${SHEET_NAME})(?::(${SHEET_NAME}))?$`, 'u');

/**
 * A name as it is compared: upper case, but only where a character has a single upper-case
 * form, so Größe stays Größe rather than becoming GRÖSSE, a different name.
 */
export function upperName(s) {
  const upper = s.toUpperCase();
  if (upper.length === s.length) return upper;
  return [...s].map((ch) => { const u = ch.toUpperCase(); return [...u].length === 1 ? u : ch; }).join('');
}

function scopedNameToken(match, start) {
  const sheet = match[1].startsWith("'") ? match[1].slice(1, -1).replace(/''/g, "'") : match[1];
  return { type: 'name', value: upperName(match[2]), sheet,
    nameStart: start + match[1].length + 1, start, end: start + match[0].length };
}

export class FormulaSyntaxError extends Error {
  constructor(message, pos) {
    super(message);
    this.pos = pos;
  }
}

/** Does an identifier run on past the cell reference of `len` characters at the start of `rest`, through a period to more than periods? */
function namedPast(rest, len) {
  if (rest[len] !== '.') return false;
  const ident = NAME_RE.exec(rest)?.[0];
  return !!ident && ident.length > len && /[^.]/u.test(ident.slice(len));
}

/** From a '[' at i, the index just past its matching ']' (' escapes the next character), or -1. */
function bracketEnd(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === "'") { j++; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) return j + 1; }
  }
  return -1;
}

export function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }

    if (ch === '"') {
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < n) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') { out += '"'; j += 2; continue; }
          closed = true;
          j++;
          break;
        }
        out += src[j++];
      }
      if (!closed) throw new FormulaSyntaxError('Unterminated string', i);
      tokens.push({ type: 'string', value: out, start: i, end: j });
      i = j;
      continue;
    }

    if (ch === '#') {
      const err = ERRORS.find((e) => src.startsWith(e, i));
      if (!err) throw new FormulaSyntaxError('Unknown error literal', i);
      // #REF!A1 is a reference to a deleted sheet, read below; #REF! on its own is the error.
      if (err !== '#REF!' || !REF_RE.test(src.slice(i))) {
        tokens.push({ type: 'error', value: err, start: i, end: i + err.length });
        i += err.length;
        continue;
      }
    }

    const rest = src.slice(i);

    const num = NUMBER_RE.exec(rest);
    // A number must not be the start of a cell ref like "1:1" handled below,
    // nor glue onto letters ("1A" is a syntax error, caught by the parser).
    if (num && !/^\$?\d{1,7}:\$?\d{1,7}/.test(rest)) {
      const value = parseDecimal(num[0]);
      // Literals are truncated to 15 significant digits, and an out-of-range
      // decimal scale is rejected before evaluating the expression. A later
      // operation (including %) cannot rescue an invalid literal.
      if (value === null) throw new FormulaSyntaxError('Number out of range', i);
      tokens.push({ type: 'number', value, start: i, end: i + num[0].length });
      i += num[0].length;
      continue;
    }

    // Keep an external workbook qualifier attached to its sheet reference,
    // rather than parsing its brackets as a separate structured reference.
    const external = ch === '[' ? EXTERNAL_RE.exec(rest)?.[0] : null;
    let ref = REF_RE.exec(external ? rest.slice(external.length) : rest);
    // FY24.Total or Q1.2025 is a defined name whose first letters and digits spell a cell: the
    // whole identifier, joined by a period to more, is read as the name below rather than the cell.
    if (ref && ref[1] !== '#REF!' && !external && namedPast(rest.slice(ref[1]?.length || 0), ref[2].length)) ref = null;
    if (ref) {
      const text = ref[2];
      let sheet = null;
      let sheetEnd = null;
      // A deleted sheet: no sheet of this name can exist, so the reference evaluates to #REF!.
      if (ref[1] === '#REF!') sheet = '#REF!';
      else if (ref[1]) {
        const unquote = (raw) => (raw.startsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw);
        // Accept both legacy separately quoted endpoints and the single
        // quoted span workbook files use, such as 'Jan Data:Mar Data'!A1.
        const raw = ref[1].slice(0, -1);
        const m = SPAN_RE.exec(raw);
        sheet = unquote(m[1]);
        if (m[2]) sheetEnd = unquote(m[2]);
        else if (sheet.includes(':')) {
          const colon = sheet.indexOf(':');
          sheetEnd = sheet.slice(colon + 1);
          sheet = sheet.slice(0, colon);
        }
        if (!sheet || sheetEnd === '' || sheet.includes(':') || sheetEnd?.includes(':')) {
          throw new FormulaSyntaxError('Invalid sheet span', i);
        }
      }
      if (external) sheet = external + sheet;
      // A trailing # names the whole spill of an array formula (A1#).
      let len = (external?.length || 0) + ref[0].length;
      const spill = rest[len] === '#' && !/^#[A-Z]/.test(rest.slice(len));
      // B1:A1# is the range operator between B1 and the spill A1#, not a block carrying #:
      // the start cell is its own reference, and the colon then joins it to the spill.
      const colon = spill && !sheetEnd ? text.indexOf(':') : -1;
      if (colon > 0 && CELL_RE.test(text.slice(0, colon))) {
        const startEnd = i + len - text.length + colon;
        tokens.push({ type: 'ref', text: text.slice(0, colon), sheet, sheetEnd, spill: false, start: i, end: startEnd });
        tokens.push({ type: 'colon', start: startEnd, end: startEnd + 1 });
        tokens.push({ type: 'ref', text: text.slice(colon + 1), sheet, sheetEnd, spill: true, start: startEnd + 1, end: i + len + 1 });
        i += len + 1;
        continue;
      }
      if (spill) len++;
      tokens.push({ type: 'ref', text, sheet, sheetEnd, spill, start: i, end: i + len });
      i += len;
      continue;
    }

    const bookName = ch === '[' && BOOK_NAME_RE.exec(rest);
    if (bookName) {
      const token = scopedNameToken(bookName, i);
      tokens.push(token); i = token.end; continue;
    }
    if (external) {
      const named = SCOPED_NAME_RE.exec(rest.slice(external.length));
      if (named) {
        const token = scopedNameToken(named, i + external.length);
        tokens.push({ ...token, sheet: external + token.sheet, start: i });
        i = token.end;
        continue;
      }
    }

    // A sheet-qualified defined name is distinct from a cell or table.
    const scoped = ch === "'" && SCOPED_NAME_RE.exec(rest);
    if (scoped) {
      tokens.push(scopedNameToken(scoped, i));
      i += scoped[0].length;
      continue;
    }

    // A bare structured reference inside a table: [@Amount], [Amount].
    if (ch === '[') {
      const end = bracketEnd(src, i);
      if (end < 0) throw new FormulaSyntaxError('Unclosed "["', i);
      tokens.push({ type: 'tref', table: null, spec: src.slice(i + 1, end - 1), start: i, end });
      i = end;
      continue;
    }

    const name = NAME_RE.exec(rest);
    if (name) {
      if (rest[name[0].length] === '!') {
        const scoped = SCOPED_NAME_RE.exec(rest);
        if (scoped) { tokens.push(scopedNameToken(scoped, i)); i += scoped[0].length; continue; }
      }
      const upper = upperName(name[0]);
      // Table1[Amount]: a name followed straight away by brackets is a structured reference.
      if (rest[name[0].length] === '[') {
        const end = bracketEnd(src, i + name[0].length);
        if (end < 0) throw new FormulaSyntaxError('Unclosed "["', i);
        tokens.push({ type: 'tref', table: name[0], spec: src.slice(i + name[0].length + 1, end - 1), start: i, end });
        i = end;
        continue;
      }
      if (upper === 'TRUE' || upper === 'FALSE') {
        tokens.push({ type: 'bool', value: upper === 'TRUE', start: i, end: i + name[0].length });
      } else {
        tokens.push({ type: 'name', value: upper, start: i, end: i + name[0].length });
      }
      i += name[0].length;
      continue;
    }

    const two = src.slice(i, i + 2);
    if (two === '<>' || two === '<=' || two === '>=') {
      tokens.push({ type: 'op', value: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if ('+-*/^&=<>%@'.includes(ch)) {
      tokens.push({ type: 'op', value: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === '(') { tokens.push({ type: 'lparen', start: i, end: i + 1 }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'rparen', start: i, end: i + 1 }); i++; continue; }
    if (ch === ',' || ch === ';') { tokens.push({ type: 'comma', value: ch, start: i, end: i + 1 }); i++; continue; }
    if (ch === '{') { tokens.push({ type: 'lbrace', start: i, end: i + 1 }); i++; continue; }
    if (ch === '}') { tokens.push({ type: 'rbrace', start: i, end: i + 1 }); i++; continue; }
    if (ch === ':') { tokens.push({ type: 'colon', start: i, end: i + 1 }); i++; continue; }

    throw new FormulaSyntaxError(`Unexpected character "${ch}"`, i);
  }

  return tokens;
}

/** The zero workbook index ([0]) selects a workbook name in the current file.
 * It is not an external link or a worksheet prefix. */
export const isWorkbookNameScope = scope => scope === '[0]';
export const isExternalFormulaToken = token =>
  (token.type === 'ref' || token.type === 'name') && token.sheet?.startsWith('[')
  && !(token.type === 'name' && isWorkbookNameScope(token.sheet));
