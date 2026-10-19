/**
 * Paste Special as composable options: what to paste (All, Formulas, Values, Formats, ...), an
 * arithmetic operation, Skip blanks and Transpose, rather than one mode at a time. `pasteOptions` reads
 * the old single modes ('values', 'transpose', 'mul', ...) into options, so every existing command keeps
 * its meaning; `legacyMode` says when options are exactly one of those modes, which the editor's proven
 * paths still carry out; `composePaste` carries out every other combination as one write.
 */
import { shiftFormula } from './refs.js';
import { NUMBER_FORMAT_KEYS } from './format.js';
import { BORDER_STYLE_KEYS } from './style-values.js';
import { mapPastedConditionalFormats, replaceConditionalFormats } from './conditional-paste.js';
import { mapPastedValidations } from './validation-paste.js';
import { maxOf } from './numeric.js';

/**
 * The Paste group of the dialog, in its two columns' reading order, with the letter each is chosen by.
 * Letters come from one rule across this group and OPERATIONS: the shortest labels choose first (ties
 * in dialog order), each taking the first letter of its label still free; B, E and L are left to the
 * dialog's Skip blanks, Transpose and Paste Link.
 */
export const PASTE_WHAT = [
  ['all', 'Everything', 'R'], ['allSourceTheme', 'Everything, with the source theme', 'H'],
  ['formulas', 'Formulas', 'O'], ['noBorders', 'Everything but borders', 'Y'],
  ['values', 'Values', 'V'], ['widths', 'Column widths', 'C'],
  ['formats', 'Formats', 'F'], ['formulasNumFmt', 'Formulas with number formats', 'W'],
  ['comments', 'Comments and notes', 'T'], ['valuesNumFmt', 'Values with number formats', 'U'],
  ['validation', 'Data validation rules', 'I'], ['allMergeCF', 'Everything, merging conditional formats', 'G'],
];
export const OPERATIONS = [['none', 'None', 'N'], ['add', 'Add', 'A'], ['sub', 'Subtract', 'S'], ['mul', 'Multiply', 'M'], ['div', 'Divide', 'D']];
/** Kinds the gallery offers beyond the dialog's: Keep Source Column Widths and Values & Source Formatting. */
const EXTRA_WHAT = ['allWidths', 'valuesSourceFmt'];
/** What the dialog still offers when the clipboard holds another app's content. */
export const EXTERNAL_WHAT = new Set(['all', 'formulas', 'values', 'formats']);

const OPS = ['add', 'sub', 'mul', 'div'];
const LEGACY = {
  all: { what: 'all' }, values: { what: 'values' }, formats: { what: 'formats' }, formulas: { what: 'formulas' },
  transpose: { what: 'all', transpose: true }, skipBlanks: { what: 'all', skipBlanks: true }, widths: { what: 'widths' },
  link: { what: 'all', link: true }, insertDown: { what: 'all', insert: 'down' }, insertRight: { what: 'all', insert: 'right' },
  // The menus' arithmetic pastes combine the copied numbers with those here and keep the formatting here.
  add: { what: 'values', operation: 'add' }, sub: { what: 'values', operation: 'sub' }, mul: { what: 'values', operation: 'mul' }, div: { what: 'values', operation: 'div' },
};

/** Options from an old mode name, or a partial options object, with every field present. */
export function pasteOptions(input = 'all') {
  const o = typeof input === 'string' ? LEGACY[input] || LEGACY.all : input || {};
  const known = PASTE_WHAT.some(([k]) => k === o.what) || EXTRA_WHAT.includes(o.what);
  return {
    what: known ? o.what : 'all',
    operation: OPS.includes(o.operation) ? o.operation : 'none',
    skipBlanks: !!o.skipBlanks,
    transpose: !!o.transpose,
    link: !!o.link,
    insert: o.insert === 'down' || o.insert === 'right' ? o.insert : null,
  };
}

/** The single mode these options are exactly, which the editor's own paste paths carry out; null for a combination. */
export function legacyMode(options, { cells = true } = {}) {
  const o = pasteOptions(options);
  if (o.insert) return o.insert === 'down' ? 'insertDown' : 'insertRight';
  if (o.link) return 'link';
  const what = o.what === 'allSourceTheme' ? 'all' : o.what;
  const extras = (o.operation !== 'none') + o.skipBlanks + o.transpose;
  if (what === 'widths') return 'widths';
  if (extras === 0 && ['all', 'values', 'formats', 'formulas'].includes(what)) return what;
  if (extras === 1 && what === 'all' && o.transpose) return 'transpose';
  if (extras === 1 && what === 'all' && o.skipBlanks) return 'skipBlanks';
  // Arithmetic over cells copied here is done with the formula rules below; another app's numbers keep the old path.
  if (extras === 1 && what === 'values' && o.operation !== 'none' && !cells) return o.operation;
  return null;
}

/** A label for the undo step and the notice. */
export function pasteLabel(options) {
  const o = pasteOptions(options);
  if (o.insert) return 'Insert copied cells';
  if (o.link) return 'Paste links';
  if (o.operation !== 'none') return 'Paste operation';
  return { values: 'Paste values', valuesNumFmt: 'Paste values', valuesSourceFmt: 'Paste values', formats: 'Paste formatting', widths: 'Paste column widths',
    comments: 'Paste comments and notes', validation: 'Paste validation' }[o.what] || 'Paste';
}

const without = (style, keys) => {
  if (!style) return undefined;
  const s = { ...style };
  for (const k of keys) delete s[k];
  return Object.keys(s).length ? s : undefined;
};
const numberFormatOf = (style) => Object.fromEntries(NUMBER_FORMAT_KEYS.filter((k) => style && Object.hasOwn(style, k)).map((k) => [k, style[k]]));
/** The cells with their borders taken off, for All except borders. */
export const withoutBorders = (cells) => cells.map((row) => row.map((cell) => (cell?.s ? { ...cell, s: without(cell.s, BORDER_STYLE_KEYS) } : cell)));

const blankCell = (cell) => !cell || (cell.v == null && cell.f == null);
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const OP_CHAR = { add: '+', sub: '-', mul: '*', div: '/' };
const tidy = (x) => (Number.isInteger(x) ? x : Number(x.toPrecision(15)));

/**
 * One cell of an arithmetic paste: the number here and the copied one; a
 * formula on either side becomes `=(here)+(copied)`; a blank counts as 0 (both blank stays blank);
 * text, logicals and errors on either side leave the cell as it is. `src` is { v, f } with f already
 * shifted; returns { v, f } or null to leave the cell's contents alone.
 */
export function combine(prev, src, op) {
  const destBlank = blankCell(prev), srcBlank = blankCell(src);
  if (destBlank && srcBlank) return null;
  const destFormula = prev?.f != null, srcFormula = src?.f != null;
  if (!destFormula && !destBlank && !isNumber(prev.v)) return null;
  if (!srcFormula && !srcBlank && !isNumber(src.v)) return null;
  if (destFormula || srcFormula) {
    const left = destFormula ? `(${prev.f})` : String(destBlank ? 0 : prev.v);
    const right = srcFormula ? `(${src.f})` : String(srcBlank ? 0 : src.v);
    return { v: null, f: `${left}${OP_CHAR[op]}${right}` };
  }
  const a = destBlank ? 0 : prev.v, b = srcBlank ? 0 : src.v;
  if (op === 'div' && b === 0) return { v: { error: '#DIV/0!' }, f: null };
  const x = op === 'add' ? a + b : op === 'sub' ? a - b : op === 'mul' ? a * b : a / b;
  return Number.isFinite(x) ? { v: tidy(x), f: null } : null;
}

/** Where content and formatting come from for each kind. */
const CONTENT = { values: 'value', valuesNumFmt: 'value', valuesSourceFmt: 'value', formats: 'dest', comments: 'dest', validation: 'dest' };
const STYLE = { all: 'src', allSourceTheme: 'src', allMergeCF: 'src', allWidths: 'src', formats: 'src', valuesSourceFmt: 'src', noBorders: 'srcNoBorders', formulasNumFmt: 'numFmt', valuesNumFmt: 'numFmt' };
const NOTES = new Set(['all', 'allSourceTheme', 'allMergeCF', 'allWidths', 'noBorders', 'comments']);
const RULES = new Set(['all', 'allSourceTheme', 'allWidths', 'noBorders', 'formats']);
const CHECKS = new Set(['all', 'allSourceTheme', 'allWidths', 'noBorders', 'allMergeCF', 'validation']);

/**
 * The cells a paste of an h × w block at (r0, c0) reaches, each with its source position:
 * a selection that is a multiple of the block takes it over and over (not when transposed).
 */
export function pastePositions(wb, h, w, r0, c0, target, transpose, limit) {
  const reps = transpose ? { rows: 1, cols: 1 } : wb.pasteReps(h, w, target);
  const out = [];
  for (let ry = 0; ry < reps.rows; ry++) for (let rx = 0; rx < reps.cols; rx++) {
    for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) {
      const r = transpose ? r0 + j : r0 + ry * h + i, c = transpose ? c0 + i : c0 + rx * w + j;
      if (r < limit.rows && c < limit.cols) out.push({ i, j, r, c });
    }
  }
  const H = transpose ? w : h * reps.rows, W = transpose ? h : w * reps.cols;
  return { reps, out, block: { r1: r0, c1: c0, r2: Math.min(limit.rows - 1, r0 + H - 1), c2: Math.min(limit.cols - 1, c0 + W - 1) } };
}

/**
 * Carry out a paste whose options are a combination the single modes do not cover. `data` is what was
 * copied: cells (formulas and styles), values (what they showed), notes, origin (where they were copied
 * from, for shifting formulas), conditionalFormats, validations, merges. Writes in one step through the
 * workbook's paste commit, which refuses protected cells the way every paste is refused. Returns the
 * block written, or null when nothing could be.
 */
export function composePaste(wb, sheetId, data, r0, c0, target, options, limit) {
  const o = pasteOptions(options);
  const { cells, values = null, notes = null, origin = null, conditionalFormats = null, validations = null, merges = [] } = data;
  const sheet = wb.sheet(sheetId);
  if (!sheet || !cells?.length || !cells[0]?.length) return null;
  const h = cells.length, w = maxOf(cells.map((row) => row.length));
  const { reps, out, block } = pastePositions(wb, h, w, r0, c0, target, o.transpose, limit);
  if (block.r2 < block.r1 || block.c2 < block.c1) return null;
  const what = o.what;
  const sourceCells = what === 'noBorders' ? withoutBorders(cells) : cells;
  const srcRow = (i) => origin?.rows?.[i] ?? (origin ? origin.r + i : null);
  const srcCol = (j) => origin?.cols?.[j] ?? (origin ? origin.c + j : null);
  // A formula copied out of a table names it (see Workbook._leaveTable).
  const leaving = (f, i, j, r, c) => (origin?.sheetId != null ? wb._leaveTable(f, wb.tableAt(origin.sheetId, srcRow(i), srcCol(j))?.name, wb.tableAt(sheetId, r, c)?.name) : f);
  const shifted = (f, i, j, r, c) => (f != null && origin ? leaving(shiftFormula(f, r - srcRow(i), c - srcCol(j)), i, j, r, c) : f);

  // Everything except an arithmetic paste of whole cells keeps the cells' own machinery (arrays, merges, sparklines).
  if (o.operation === 'none' && ['all', 'allSourceTheme', 'allMergeCF', 'allWidths', 'noBorders', 'formulas'].includes(what)) {
    const keepStyles = what === 'formulas';
    const pasted = wb.pasteCells(sheetId, sourceCells, r0, c0, origin, target, {
      transpose: o.transpose, skipBlanks: o.skipBlanks, keepStyles,
      notes: keepStyles ? null : notes, merges: keepStyles ? [] : merges,
      conditionalFormats: keepStyles || what === 'allMergeCF' ? null : conditionalFormats,
      validations: keepStyles ? null : validations,
    });
    if (what === 'allMergeCF' && conditionalFormats?.length) {
      // The copied rules join those already here instead of replacing them.
      const incoming = mapPastedConditionalFormats(conditionalFormats, h, w, r0, c0, reps, o.transpose);
      const reached = out.filter(({ i, j }) => !o.skipBlanks || !blankCell(cells[i]?.[j])).map(({ r, c }) => ({ r, c }));
      let n = 0;
      const added = incoming ? replaceConditionalFormats([], incoming, reached, () => `ps${Date.now().toString(36)}${(n++).toString(36)}`, sheet.name) : [];
      if (added.length) wb._setRules(sheet, [...added, ...sheet.rules], 'Paste');
    }
    return { block, pasted };
  }

  const content = CONTENT[what] || 'src';
  const styleFrom = STYLE[what] || 'dest';
  const entries = [], noteWrites = [];
  for (const { i, j, r, c } of out) {
    if (wb._coveredByMerge(sheetId, r, c)) continue;
    const src = sourceCells[i]?.[j] ?? null;
    if (o.skipBlanks && blankCell(src) && !(what === 'comments' && notes?.[i]?.[j])) continue;
    const prev = wb.getCell(sheetId, r, c);
    if (what === 'comments') {
      if (notes?.[i]?.[j]) noteWrites.push({ r, c, text: notes[i][j] });
      continue;
    }
    let cell;
    if (content === 'dest') cell = prev ? { ...prev } : { v: null, f: null };
    else if (content === 'value') {
      const value = values ? values[i]?.[j] ?? null : (src?.f == null ? src?.v ?? null : null);
      cell = { v: value === '' ? null : value, f: null };
    } else {
      cell = src ? { ...src, f: shifted(src.f, i, j, r, c) } : { v: null, f: null };
      delete cell.array;
    }
    if (o.operation !== 'none' && content !== 'dest') {
      const result = combine(prev, cell, o.operation);
      cell = result ? { ...cell, ...result } : prev ? { ...prev } : { v: null, f: null };
      delete cell.richText;
    }
    if (styleFrom === 'src' || styleFrom === 'srcNoBorders') cell.s = wb.replacedCellStyle(sheetId, r, c, src?.s);
    else if (styleFrom === 'numFmt') {
      const s = { ...without(prev?.s, NUMBER_FORMAT_KEYS), ...numberFormatOf(src?.s) };
      cell.s = Object.keys(s).length ? s : undefined;
    } else cell.s = prev?.s;
    if (content !== 'dest' && styleFrom === 'dest' && prev?.hyperlink && cell.hyperlink == null) cell.hyperlink = prev.hyperlink;
    if (cell.s === undefined) delete cell.s;
    entries.push({ r, c, cell });
    if (NOTES.has(what)) noteWrites.push({ r, c, text: notes?.[i]?.[j] ?? null });
  }
  if (what === 'comments') {
    if (!noteWrites.length) return { block, pasted: null };
    if (wb.lockedIn(sheetId, block)) return null;
    wb.transaction('Paste comments and notes', () => { for (const { r, c, text } of noteWrites) wb.setNote(sheetId, r, c, text); });
    return { block, pasted: null };
  }
  if (!entries.length) return { block, pasted: null };
  const rules = RULES.has(what) ? mapPastedConditionalFormats(conditionalFormats, h, w, r0, c0, reps, o.transpose) : null;
  const checks = CHECKS.has(what) ? mapPastedValidations(validations, h, w, r0, c0, reps, o.transpose) : null;
  const pasted = wb._commitPaste(sheetId, entries, noteWrites, { conditionalFormats: rules, validations: checks });
  return { block, pasted };
}

/** Another app's plain text as cells to compose with: each entry read as typed, with no formatting of its own. */
export function cellsFromText(rows, read) {
  const w = maxOf(rows.map((row) => row.length), 0);
  const cells = rows.map((row) => Array.from({ length: w }, (_, j) => (row[j] == null || row[j] === '' ? null : read(row[j]))));
  return { cells, values: cells.map((row) => row.map((cell) => (cell && cell.f == null ? cell.v : null))) };
}
