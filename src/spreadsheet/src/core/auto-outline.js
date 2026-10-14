/**
 * Data ▸ Outline ▸ Auto Outline: outline groups worked out from the summary formulas on a sheet.
 *
 * A summary formula is one that totals (SUM, SUBTOTAL, AVERAGE and the like) a run of cells next to it: in its own
 * column, ending on the row just above it (or starting just below it, when summary rows sit above their detail), or
 * in its own row, ending on the column just to its left (or starting just to its right). Each such run is the
 * detail of a group; a grand total over runs that hold subtotals gives the outer group, so groups nest the way the
 * totals do. A run that would only partly overlap one already found is left out, as are groups past the eighth level.
 */

import { tokenize } from './formula/tokenizer.js';
import { parseRefText } from './refs.js';
import { parseKey } from './cell.js';
import { outlineSettingsOf } from './workbook.js';

/** Functions that summarize the cells they read. */
export const SUMMARY_FUNCTIONS = new Set(['SUM', 'SUBTOTAL', 'AGGREGATE', 'AVERAGE', 'AVERAGEA', 'COUNT', 'COUNTA', 'MAX', 'MAXA', 'MIN', 'MINA', 'PRODUCT',
  'MEDIAN', 'STDEV', 'STDEV.S', 'STDEV.P', 'STDEVA', 'STDEVP', 'VAR', 'VAR.S', 'VAR.P', 'VARA', 'VARP', 'SUMSQ']);

const MAX_LEVELS = 7; // eight outline levels: the sheet's own, and seven of groups

/** The same-sheet ranges a formula reads, when it calls a summary function; [] otherwise. */
function summaryRefs(formula, sheetName) {
  let tokens;
  try { tokens = tokenize(String(formula)); } catch { return []; }
  const summarizes = tokens.some((t, i) => t.type === 'name' && tokens[i + 1]?.type === 'lparen' && SUMMARY_FUNCTIONS.has(String(t.value).toUpperCase().replace(/^_XLFN\./, '')));
  if (!summarizes) return [];
  const out = [];
  for (const t of tokens) {
    if (t.type !== 'ref' || t.sheetEnd) continue;
    if (t.sheet && t.sheet.toLowerCase() !== sheetName.toLowerCase()) continue;
    const ref = parseRefText(t.text, t.sheet);
    if (ref && (ref.kind === 'cell' || ref.kind === 'range')) out.push(ref);
  }
  return out;
}

/**
 * The run of lines `refs` cover along one axis next to a summary line at `at` on the other: the union of the
 * references lying across `across` must be one unbroken run ending just before `at` (`before`) or starting just
 * after it. Null when it is not.
 */
function detailRun(refs, at, across, before, axis) {
  const [lo, hi, olo, ohi] = axis === 'row' ? ['r1', 'r2', 'c1', 'c2'] : ['c1', 'c2', 'r1', 'r2'];
  const lines = refs.filter((rf) => rf[olo] <= across && rf[ohi] >= across);
  if (!lines.length) return null;
  const spans = lines.map((rf) => [rf[lo], rf[hi]]).sort((a, b) => a[0] - b[0]);
  let [from, to] = spans[0];
  for (const [a, b] of spans.slice(1)) {
    if (a > to + 1) return null; // a gap: not one run of detail
    to = Math.max(to, b);
  }
  if (before ? to !== at - 1 : from !== at + 1) return null;
  return { from, to };
}

/**
 * The groups Auto Outline would build on a sheet, within `range` (the whole used range when null):
 * { rows: [{ from, to }], cols: [...] }, outermost first.
 */
export function autoOutlineGroups(wb, sheetId, range = null) {
  const sheet = wb.sheet(sheetId);
  if (!sheet) return { rows: [], cols: [] };
  const area = range || wb.usedRange(sheetId);
  if (!area) return { rows: [], cols: [] };
  const { summaryBelow, summaryRight } = outlineSettingsOf(sheet);
  const found = { row: new Map(), col: new Map() };
  for (const [key, cell] of sheet.cells) {
    if (cell.f == null) continue;
    const { r, c } = parseKey(key);
    if (r < area.r1 || r > area.r2 || c < area.c1 || c > area.c2) continue;
    const refs = summaryRefs(cell.f, sheet.name);
    if (!refs.length) continue;
    const down = detailRun(refs, r, c, summaryBelow, 'row');
    if (down) found.row.set(`${down.from}:${down.to}`, down);
    const across = detailRun(refs, c, r, summaryRight, 'col');
    if (across) found.col.set(`${across.from}:${across.to}`, across);
  }
  return { rows: nest([...found.row.values()]), cols: nest([...found.col.values()]) };
}

/** Keep the runs that nest: largest first, each inside or apart from those kept, at most seven deep. */
function nest(runs) {
  const kept = [];
  for (const g of runs.sort((a, b) => (b.to - b.from) - (a.to - a.from) || a.from - b.from)) {
    const partial = kept.some((k) => (k.from < g.from && k.to >= g.from && k.to < g.to) || (k.from > g.from && k.from <= g.to && k.to > g.to));
    if (partial) continue;
    if (kept.filter((k) => k.from <= g.from && k.to >= g.to).length >= MAX_LEVELS) continue;
    kept.push({ from: g.from, to: g.to });
  }
  return kept.sort((a, b) => a.from - b.from || b.to - a.to);
}

/**
 * Build the outline: the found groups replace those on the sheet (both axes), one undo step. Returns how many
 * groups were made, or 0 when no summary formula was found (the sheet is left as it was).
 */
export function autoOutline(wb, sheetId, range = null) {
  const groups = autoOutlineGroups(wb, sheetId, range);
  const count = groups.rows.length + groups.cols.length;
  if (!count) return 0;
  const made = (list) => list.map((g) => ({ ...g, collapsed: false }));
  wb.transaction('Auto Outline', () => {
    wb.replaceGroups(sheetId, { rows: made(groups.rows), cols: made(groups.cols) }, 'Auto Outline');
    if (outlineSettingsOf(wb.sheet(sheetId)).autoStyles) applyOutlineStyles(wb, sheetId);
  });
  return count;
}

/**
 * Clear Outline: the row and column groups within `range` go (all of them when it is null or covers the sheet),
 * and the lines they had hidden come back. One undo step; false when there was nothing to clear.
 */
export function clearOutline(wb, sheetId, range = null) {
  const sheet = wb.sheet(sheetId);
  if (!sheet) return false;
  const keep = (list, lo, hi) => (range ? list.filter((g) => g.to < lo || g.from > hi) : []);
  const rows = keep(sheet.groups.rows, range?.r1, range?.r2);
  const cols = keep(sheet.groups.cols, range?.c1, range?.c2);
  if (rows.length === sheet.groups.rows.length && cols.length === sheet.groups.cols.length) return false;
  return wb.replaceGroups(sheetId, { rows, cols }, 'Clear Outline');
}

/**
 * The summary lines of the outline: for each group, the row (or column) its button sits on, with the group's
 * level. A line that summarizes groups at several levels takes the outermost.
 */
export function summaryLines(wb, sheetId, axis) {
  const sheet = wb.sheet(sheetId);
  if (!sheet) return new Map();
  const settings = outlineSettingsOf(sheet);
  const after = axis === 'row' ? settings.summaryBelow : settings.summaryRight;
  const out = new Map();
  for (const g of wb.outlineGroups(sheetId, axis)) {
    const line = after ? g.to + 1 : g.from - 1;
    if (line < 0) continue;
    out.set(line, Math.min(out.get(line) ?? Infinity, g.level));
  }
  return out;
}

/**
 * Apply Styles: the summary rows and columns of the outline in bold, across the used range, so the totals stand
 * out. One undo step; false when there is no outline.
 */
export function applyOutlineStyles(wb, sheetId) {
  const rows = summaryLines(wb, sheetId, 'row');
  const cols = summaryLines(wb, sheetId, 'col');
  if (!rows.size && !cols.size) return false;
  const used = wb.usedRange(sheetId);
  if (!used) return false;
  wb.transaction('Apply outline styles', () => {
    for (const r of rows.keys()) if (r >= used.r1 && r <= used.r2) wb.applyStyle(sheetId, { r1: r, c1: used.c1, r2: r, c2: used.c2 }, { bold: true });
    for (const c of cols.keys()) if (c >= used.c1 && c <= used.c2) wb.applyStyle(sheetId, { r1: used.r1, c1: c, r2: used.r2, c2: c }, { bold: true });
  });
  return true;
}
