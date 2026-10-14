/**
 * Operations of a shared workbook: what one person's edit sends to everyone else, how an operation is checked
 * (the browser and the room worker use the same rules), and how the positions an operation names move when
 * rows, columns or sheets change under it.
 *
 * A change is { id, label, ops }. Its operations are applied in order and are of two kinds:
 *
 * Registers, which set state outright (the last change in the room's order wins, register by register):
 *   { t: 'cells', s, v: { 'r,c': content | null }, st: { 'r,c': { styleProp: value | null } } }
 *   { t: 'props', s, v: { sheetProp: json | null } }          one register per sheet setting (merges, rules, …)
 *   { t: 'lines', s, p, v: { index: value | null } }         one register per row or column (widths, …)
 *   { t: 'book', v: { bookProp: json | null } }               one register per workbook setting (names, …)
 *   { t: 'put', s, at, sheet }                                a new sheet, whole
 *
 * Structure, replayed by the workbook itself, so that every formula, range and setting follows as it does
 * for a local edit:
 *   { t: 'insert', s, axis, at, n }   { t: 'delete', s, axis, runs: [{ from, to }] }
 *   { t: 'move', s, axis, from, count, to }
 *   { t: 'rename', s, name }   { t: 'drop', s }   { t: 'order', s, to }
 *
 * Nothing here reads a workbook: the worker bundles this file alone.
 */

export const MAX_ROW = 1048575;
export const MAX_COL = 16383;
/** Largest change a commit carries (characters of JSON). */
export const MAX_CHANGE = 4_000_000;
export const MAX_OPS = 20_000;

/** Settings kept per row or column (or per cell, for notes): each index is a register of its own. */
export const LINE_PROPS = Object.freeze({
  colWidths: 'col', colStyles: 'col', hiddenCols: 'col',
  rowHeights: 'row', rowHeightModes: 'row', rowStyles: 'row', hiddenRows: 'row',
  notes: 'cell',
});

/**
 * A sheet's settings that are one register each. What a sheet holds for one person's view (zoom, the
 * selection, where it is scrolled, a split window, page layout view) is theirs and is never shared, nor is
 * its size (it grows as far as someone scrolls), nor anything in LINE_PROPS.
 */
export const SHEET_PROPS = Object.freeze(['kind', 'frozenRows', 'frozenCols', 'frozenOrigin', 'color', 'hidden', 'veryHidden', 'protected',
  'gridlines', 'headers', 'rightToLeft', 'defaultVAlign', 'zeros', 'printSettings', 'groups', 'filter', 'otherFilters', 'filterHidden',
  'merges', 'comments', 'rules', 'protectedRanges', 'scenarios', 'validations', 'sparklineGroups', 'charts', 'tables', 'nativeWidths',
  'nativeDefaultHeight', 'defaultColWidth', 'defaultRowHeight', 'ignoredErrors', 'styleResets', 'outlineSettings', 'background', 'sheetViews']);
/** Never shared: one person's view of a sheet. */
export const VIEW_PROPS = Object.freeze(['showPageBreaks', 'personalView', 'viewZoom', 'viewMode', 'viewSelection', 'viewOrigin', 'split', 'zoomToFit', 'rows', 'cols', 'id', 'name']);

/** Workbook settings, one register each (the workbook's BOOK_STATE_KEYS; a test keeps the two lists alike). */
export const BOOK_PROPS = Object.freeze(['dataModel', 'nativePivots', 'externalWorkbooks', 'iteration', 'calcMode', 'structureProtected', 'queries', 'watches',
  'calculationCompatibility', 'colorPalette', 'fontTheme', 'themeInfo', 'normalFont', 'nativeNormalStyle', 'nativeNormalFill', 'nativeDefaultCellFormat', 'names',
  'scripts', 'cellStyles', 'linkStartup', 'customViews']);

export const STRUCTURE = new Set(['insert', 'delete', 'move', 'rename', 'drop', 'order', 'put']);
export const isStructure = (op) => STRUCTURE.has(op.t) && op.t !== 'put';

const SHEET_PROP_SET = new Set(SHEET_PROPS);
const BOOK_PROP_SET = new Set(BOOK_PROPS);
const CELL_KEY = /^(\d{1,7}),(\d{1,5})$/;
const CHANGE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The row and column a cell key names, or null when it names none within the grid. */
export function parseCellKey(key) {
  const m = CELL_KEY.exec(key);
  if (!m) return null;
  const r = Number(m[1]), c = Number(m[2]);
  return r <= MAX_ROW && c <= MAX_COL ? { r, c } : null;
}

export class OpError extends Error {}
const bad = (why) => { throw new OpError(`Invalid change: ${why}`); };
const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const sheetId = (s) => (typeof s === 'string' && s.length > 0 && s.length <= 100 && !/[\u0000-\u001f]/.test(s) ? s : bad('sheet'));
const axisMax = (axis) => (axis === 'row' ? MAX_ROW : axis === 'col' ? MAX_COL : bad('axis'));

/** Throw unless `change` is a well-formed change (see the top of this file). Its size is the caller's to bound. */
export function validateChange(change) {
  if (!isRecord(change)) bad('change');
  if (typeof change.id !== 'string' || !CHANGE_ID.test(change.id)) bad('id');
  if (change.label != null && (typeof change.label !== 'string' || change.label.length > 200)) bad('label');
  if (!Array.isArray(change.ops) || !change.ops.length || change.ops.length > MAX_OPS) bad('ops');
  for (const op of change.ops) validateOp(op);
  return change;
}

export function validateOp(op) {
  if (!isRecord(op)) bad('operation');
  switch (op.t) {
    case 'cells': {
      sheetId(op.s);
      const v = op.v ?? {}, st = op.st ?? {};
      if (!isRecord(v) || !isRecord(st)) bad('cells');
      for (const [key, content] of Object.entries(v)) {
        if (!parseCellKey(key)) bad('cell');
        if (content !== null && (!isRecord(content) || own(content, 's'))) bad('cell content');
      }
      for (const [key, patch] of Object.entries(st)) {
        if (!parseCellKey(key) || !isRecord(patch)) bad('cell style');
        for (const k of Object.keys(patch)) if (k.length > 64) bad('style');
      }
      return;
    }
    case 'props':
      sheetId(op.s);
      if (!isRecord(op.v)) bad('props');
      for (const k of Object.keys(op.v)) if (!SHEET_PROP_SET.has(k)) bad(`setting ${k.slice(0, 40)}`);
      return;
    case 'lines': {
      sheetId(op.s);
      const kind = LINE_PROPS[op.p];
      if (!kind || !own(LINE_PROPS, op.p) || !isRecord(op.v)) bad('lines');
      for (const k of Object.keys(op.v)) {
        if (kind === 'cell' ? !parseCellKey(k) : !/^\d{1,7}$/.test(k) || Number(k) > axisMax(kind)) bad('line');
      }
      return;
    }
    case 'book':
      if (!isRecord(op.v)) bad('book');
      for (const k of Object.keys(op.v)) if (!BOOK_PROP_SET.has(k)) bad(`setting ${k.slice(0, 40)}`);
      return;
    case 'insert':
      sheetId(op.s);
      if (!intIn(op.at, 0, axisMax(op.axis)) || !intIn(op.n, 1, axisMax(op.axis) + 1)) bad('insert');
      return;
    case 'delete':
      sheetId(op.s);
      axisMax(op.axis);
      if (!Array.isArray(op.runs) || !op.runs.length || op.runs.length > 100_000) bad('delete');
      for (const run of op.runs) if (!isRecord(run) || !intIn(run.from, 0, axisMax(op.axis)) || !intIn(run.to, run.from, axisMax(op.axis))) bad('delete');
      return;
    case 'move':
      sheetId(op.s);
      if (!intIn(op.from, 0, axisMax(op.axis)) || !intIn(op.count, 1, axisMax(op.axis) + 1) || !intIn(op.to, 0, axisMax(op.axis) + 1)) bad('move');
      return;
    case 'rename':
      sheetId(op.s);
      if (typeof op.name !== 'string' || !op.name || op.name.length > 31) bad('rename');
      return;
    case 'drop':
      sheetId(op.s);
      return;
    case 'order':
      sheetId(op.s);
      if (!intIn(op.to, 0, 10_000)) bad('order');
      return;
    case 'put':
      sheetId(op.s);
      if (!intIn(op.at, 0, 10_000) || !isRecord(op.sheet) || !isRecord(op.sheet.cells ?? {})) bad('sheet');
      for (const key of Object.keys(op.sheet.cells ?? {})) if (!parseCellKey(key)) bad('cell');
      return;
    default:
      bad('operation type');
  }
}

/* ---------- Where positions go ---------- */

/** Merged, sorted deletion runs. */
export function mergeRuns(runs) {
  const sorted = runs.filter((r) => r.to >= r.from).map((r) => ({ from: r.from, to: r.to })).sort((a, b) => a.from - b.from);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
    else out.push(r);
  }
  return out;
}

/** Lines deleted before line i (exclusive), and whether i itself is deleted. */
function deletedBefore(runs, i) {
  let n = 0;
  for (const r of runs) {
    if (r.from >= i) break;
    n += Math.min(r.to, i - 1) - r.from + 1;
  }
  return n;
}
const deletedAt = (runs, i) => runs.some((r) => i >= r.from && i <= r.to);

/**
 * Where line i (of `axis` on sheet `s`) is after `op`, or -1 when the operation removed it. Lines of other
 * sheets and axes stay; a dropped sheet takes all of its lines.
 */
export function mapLine(op, s, axis, i) {
  if (op.s !== s) return i;
  if (op.t === 'drop') return -1;
  if (op.axis !== axis) return i;
  if (op.t === 'insert') return i >= op.at ? i + op.n : i;
  if (op.t === 'delete') {
    const runs = mergeRuns(op.runs);
    return deletedAt(runs, i) ? -1 : i - deletedBefore(runs, i);
  }
  if (op.t === 'move') return moveIndex(op, i);
  return i;
}

/** Where line i goes when the block [from, from + count) moves to land before line `to`. */
export function moveIndex({ from, count, to }, i) {
  const end = from + count;
  if (to > end) {
    if (i >= from && i < end) return to - count + (i - from);
    if (i >= end && i < to) return i - count;
    return i;
  }
  if (to < from) {
    if (i >= from && i < end) return to + (i - from);
    if (i >= to && i < from) return i + count;
    return i;
  }
  return i;
}

/** Where an insertion point (the gap before line i) is after `op`. */
export function mapGap(op, s, axis, i) {
  if (op.s !== s || op.axis !== axis) return i;
  if (op.t === 'insert') return i >= op.at ? i + op.n : i;
  if (op.t === 'delete') return i - deletedBefore(mergeRuns(op.runs), i);
  // The gap before a line goes wherever that line goes.
  if (op.t === 'move') return moveIndex(op, i);
  return i;
}

/** Where a cell key goes after `op` (null when its row, column or sheet went). */
export function mapCellKey(op, s, key) {
  if (op.s !== s) return key;
  if (op.t === 'drop') return null;
  const p = parseCellKey(key);
  if (!p) return null;
  const r = mapLine(op, s, 'row', p.r), c = mapLine(op, s, 'col', p.c);
  return r < 0 || c < 0 ? null : `${r},${c}`;
}

/** Where a LINE_PROPS key goes after `op` (null when its line went). */
export function mapLineKey(op, s, prop, key) {
  const kind = LINE_PROPS[prop];
  if (kind === 'cell') return mapCellKey(op, s, key);
  if (op.s !== s) return key;
  if (op.t === 'drop') return null;
  const i = mapLine(op, s, kind, Number(key));
  return i < 0 ? null : String(i);
}

/* ---------- Structure against structure ---------- */

const sameLines = (a, b) => a.s === b.s && a.axis === b.axis && a.axis != null;
const LINE_OPS = new Set(['insert', 'delete', 'move']);

/** Runs of the sorted lines in `lines` (an ascending array of indices). */
function runsOf(lines) {
  const out = [];
  for (const i of lines) {
    const last = out[out.length - 1];
    if (last && i === last.to + 1) last.to = i;
    else out.push({ from: i, to: i });
  }
  return out;
}

/** The lines of `runs`, each mapped through `op` (deleted ones dropped), as runs again. */
function mapRuns(runs, op, s, axis) {
  const lines = [];
  for (const r of mergeRuns(runs)) for (let i = r.from; i <= r.to; i++) { const j = mapLine(op, s, axis, i); if (j >= 0) lines.push(j); }
  lines.sort((a, b) => a - b);
  return runsOf(lines);
}

/** A deletion's runs after an insertion: the inserted lines are not deleted, so a run around the insertion splits. */
function runsAfterInsert(runs, ins) {
  const out = [];
  for (const r of mergeRuns(runs)) {
    if (r.to < ins.at) out.push(r);
    else if (r.from >= ins.at) out.push({ from: r.from + ins.n, to: r.to + ins.n });
    else { out.push({ from: r.from, to: ins.at - 1 }); out.push({ from: ins.at + ins.n, to: r.to + ins.n }); }
  }
  return out;
}

/** Map a structural line operation `a` through `b` (both on the same sheet and axis): the list `a` becomes after `b`. */
function lineAfter(a, b, aFirst) {
  if (a.t === 'insert') {
    let at;
    if (b.t === 'insert') at = b.at < a.at || (b.at === a.at && !aFirst) ? a.at + b.n : a.at;
    else at = mapGap(b, a.s, a.axis, a.at);
    return [{ ...a, at }];
  }
  if (a.t === 'delete') {
    const runs = b.t === 'insert' ? runsAfterInsert(a.runs, b) : mapRuns(a.runs, b, a.s, a.axis);
    return runs.length ? [{ ...a, runs }] : [];
  }
  // A move: its block's lines after `b`. A block that no longer lies together moves no more (it would scatter
  // lines someone else placed); an insertion inside it joins the block.
  const lines = [];
  for (let i = a.from; i < a.from + a.count; i++) { const j = mapLine(b, a.s, a.axis, i); if (j >= 0) lines.push(j); }
  if (b.t === 'insert' && b.at > a.from && b.at < a.from + a.count) for (let k = 0; k < b.n; k++) lines.push(b.at + k);
  lines.sort((x, y) => x - y);
  if (!lines.length || lines[lines.length - 1] - lines[0] + 1 !== lines.length) return [];
  const to = mapGap(b, a.s, a.axis, a.to);
  const from = lines[0], count = lines.length;
  if (to >= from && to <= from + count) return [];
  return [{ ...a, from, count, to }];
}

/**
 * Transform two structural operations made at once on the same state: [a after b, b after a], each a list
 * (an operation can vanish, or a deletion split). `aFirst` breaks ties between insertions at the same line, and
 * decides which of two renames, or two moves, of one sheet stands: the room's order has b first, so a stands
 * when a is the later edit (mine, rebased onto theirs).
 */
export function transformStructure(a, b, aFirst = false, aWins = true) {
  // A dropped sheet takes every operation on it with it.
  if (b.t === 'drop' && a.s === b.s) return [[], a.t === 'drop' ? [] : [b]];
  if (a.t === 'drop' && a.s === b.s) return [[a], []];
  if (LINE_OPS.has(a.t) && LINE_OPS.has(b.t)) {
    if (!sameLines(a, b)) return [[a], [b]];
    return [lineAfter(a, b, aFirst), lineAfter(b, a, !aFirst)];
  }
  if ((a.t === 'rename' && b.t === 'rename') || (a.t === 'order' && b.t === 'order')) {
    if (a.s !== b.s) return [[a], [b]];
    return aWins ? [[a], []] : [[], [b]];
  }
  return [[a], [b]];
}
