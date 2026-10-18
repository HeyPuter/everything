/**
 * Subtotals (Data → Subtotal): the rows of a range grouped by the value in
 * one column, a SUBTOTAL row written under each group and a grand total
 * under everything, with the detail rows outlined so they can collapse.
 * SUBTOTAL skips nested subtotal cells, so the grand total is not doubled.
 */

import { colName, normalizeRange, parseKey } from './cell.js';

export const SUBTOTAL_FUNCTIONS = [
  [9, 'Sum'], [3, 'Count'], [1, 'Average'], [4, 'Max'], [5, 'Min'], [6, 'Product'], [2, 'Count numbers'], [7, 'Standard deviation'], [10, 'Variance'],
];

const SUBTOTAL_RE = /^\s*(?:_xlfn\.)?SUBTOTAL\s*\(/i;
// The labels this feature writes: "West Total", "(blank) Total", "Grand Total"; never a bare "Total" or "Subtotal".
const TOTAL_LABEL_RE = /\S\s+Total$/;

// Prefix text too: literal "number:1" must not collide with the number 1. Errors group by their code, so #N/A
// rows do not fall under a #DIV/0! total.
const identity = (v) => (v == null || v === '' ? 'string:' : typeof v === 'string' ? `string:${v.trim().toLowerCase()}`
  : typeof v === 'object' ? `error:${v.error ?? ''}` : `${typeof v}:${v}`);

/** Does any row of the range hold subtotals this feature added? */
export function hasSubtotals(wb, sheetId, range) {
  for (const r of subtotalRows(wb, sheetId, range)) return true;
  return false;
}

/**
 * The rows this feature wrote: a SUBTOTAL formula beside a "... Total" label on the same row of the range.
 * A SUBTOTAL row of the user's own (a running total) is not one of them. Only stored cells are read, so
 * large selections stay cheap to inspect.
 */
function* subtotalRows(wb, sheetId, range) {
  const n = normalizeRange(range);
  const formulas = new Set();
  const labels = new Set();
  for (const [key, cell] of wb.sheet(sheetId)?.cells || []) {
    const formula = SUBTOTAL_RE.test(cell?.f || '');
    const label = !formula && cell?.f == null && typeof cell?.v === 'string' && TOTAL_LABEL_RE.test(cell.v);
    if (!formula && !label) continue;
    const { r, c } = parseKey(key);
    if (r >= n.r1 && r <= n.r2 && c >= n.c1 && c <= n.c2) (formula ? formulas : labels).add(r);
  }
  for (const r of formulas) if (labels.has(r)) yield r;
}

/** Are the rows of a range already gathered by the value in `groupCol`, so that no sort is needed to form the groups? */
export function groupsContiguous(wb, sheetId, range, groupCol) {
  const n = normalizeRange(range);
  const seen = new Set();
  let key = null;
  for (let r = n.r1; r <= n.r2; r++) {
    const k = identity(wb.getValue(sheetId, r, groupCol));
    if (k === key) continue;
    if (seen.has(k)) return false;
    seen.add(k);
    key = k;
  }
  return true;
}

/** Does a table share any cell with the range? Subtotals cannot go inside one. */
export function tableOverlaps(wb, sheetId, range) {
  const n = normalizeRange(range);
  return (wb.sheet(sheetId)?.tables || []).some(({ range: t }) => t.r1 <= n.r2 && t.r2 >= n.r1 && t.c1 <= n.c2 && t.c2 >= n.c1);
}

/** Number-format fields of a style, so a total row shows money as money. */
function formatOf(style) {
  const out = {};
  for (const k of ['fmt', 'dec', 'cur', 'dateStyle', 'sec', 'group', 'code']) if (style?.[k] != null) out[k] = style[k];
  return out;
}

/**
 * Add subtotal rows. Returns the range including the new rows, or null.
 * opts: { groupCol, code, totalCols, header, sort, group }
 *   groupCol   column whose changes start a new group
 *   code       SUBTOTAL function number (9 = SUM)
 *   totalCols  columns to total
 *   header     first row is a header (default true)
 *   sort       sort the rows by groupCol first (default true)
 *   group      outline the detail rows (default true)
 */
export function addSubtotals(wb, sheetId, range, { groupCol, code = 9, totalCols = [], header = true, sort = true, group = true }) {
  const n = normalizeRange(range);
  const r0 = header ? n.r1 + 1 : n.r1;
  if (r0 > n.r2 || groupCol < n.c1 || groupCol > n.c2) return null;
  // Every write below would be refused on a protected sheet; report nothing done rather than a moved selection.
  if (wb.isProtected(sheetId)) return null;
  // Total rows inserted inside a table would become its data rows, and every structured reference over
  // the table would count them again. Subtotal is refused on tables; the table is converted to a range first.
  if (tableOverlaps(wb, sheetId, n)) return null;
  // The group column holds the labels, so it cannot be totalled: without another column there is nothing to add up.
  const cols = totalCols.filter((c) => c >= n.c1 && c <= n.c2 && c !== groupCol);
  if (!cols.length) return null;
  // Rows that cannot change places (merged cells, an array result, protected cells) cannot be
  // sorted into groups; unless they already lie grouped, totals over them would split every group.
  if (sort && wb.rearrangeBlocker(sheetId, { ...n, r1: r0 }) && !groupsContiguous(wb, sheetId, { ...n, r1: r0 }, groupCol)) return null;
  // Subtotals already in the range are replaced: totals added over totals would
  // take the old total rows for data and count them again.
  if (n.r2 - new Set(subtotalRows(wb, sheetId, n)).size < r0) return null;
  const top = wb.historyTop;
  let refused = false;
  const out = wb.transaction('Add subtotals', () => {
    const end = n.r2 - removeSubtotals(wb, sheetId, n);
    if (sort) wb.sortRangeBy(sheetId, { ...n, r1: r0, r2: end }, [{ col: groupCol, ascending: true }]);
    const groups = [];
    let start = r0;
    let key = identity(wb.getValue(sheetId, r0, groupCol));
    for (let r = r0 + 1; r <= end; r++) {
      const k = identity(wb.getValue(sheetId, r, groupCol));
      if (k !== key) { groups.push({ from: start, to: r - 1 }); start = r; key = k; }
    }
    groups.push({ from: start, to: end });
    const totalRow = (r, label, from, to, extra) => {
      const entries = [{ r, c: groupCol, cell: { v: label, f: null, s: { bold: true, ...extra } } }];
      for (const c of cols) {
        if (c === groupCol) continue;
        const fmt = formatOf(wb.getCell(sheetId, to, c)?.s);
        entries.push({ r, c, cell: { v: null, f: `SUBTOTAL(${code},${colName(c)}${from + 1}:${colName(c)}${to + 1})`, s: { ...fmt, bold: true, ...extra } } });
      }
      wb.setCells(sheetId, entries, 'Add subtotals');
    };
    // Group rows go in bottom-up so the indices above stay valid; the grand total row comes last,
    // spanning everything above it (SUBTOTAL skips the group totals, so nothing is counted twice).
    if (!wb.insertRows(sheetId, end + 1, 1)) { refused = true; return null; }
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i];
      const label = wb.getDisplay(sheetId, g.from, groupCol) || '(blank)';
      if (!wb.insertRows(sheetId, g.to + 1, 1)) { refused = true; return null; }
      totalRow(g.to + 1, `${label} Total`, g.from, g.to, {});
    }
    const last = end + groups.length + 1;
    totalRow(last, 'Grand Total', r0, last - 1, { bt: true, bs: 'thin' });
    if (group) {
      wb.groupLines(sheetId, 'row', r0, last - 1);
      groups.forEach((g, i) => wb.groupLines(sheetId, 'row', g.from + i, g.to + i));
    }
    // Every total row belongs on the same side of the filter. Those inserted inside a filtered list grew
    // its range with them, while the last group's total and the grand total landed under it: the range is
    // extended over those too, and all of them stay in view until the filter is applied again, as rows
    // added to a filtered table do. Otherwise a later filter change hid one total row and not the others.
    wb.extendFilterOverRows(sheetId, n.r1, last, [...groups.map((g, i) => g.to + i + 1), last], n);
    return { ...n, r2: last };
  });
  // A row refused (a protected range or an array formula across the rows) would have had its total written over
  // the next group's first row: what the step did up to there, the sort and the old totals' removal, is taken back.
  if (refused && wb.historyTop !== top) wb.discardSteps(new Set([wb.historyTop]));
  return out;
}

/** Delete every row of the range that holds a SUBTOTAL formula and drop the row groups inside it. */
export function removeSubtotals(wb, sheetId, range) {
  if (wb.isProtected(sheetId)) return 0; // every deletion below would be refused
  const n = normalizeRange(range);
  const rows = [...new Set(subtotalRows(wb, sheetId, n))].sort((a, b) => a - b);
  if (!rows.length) return 0;
  wb.transaction('Remove subtotals', () => {
    for (const g of wb.outlineGroups(sheetId, 'row').filter((x) => x.from >= n.r1 && x.to <= n.r2).sort((a, b) => b.from - a.from)) wb.ungroupLines(sheetId, 'row', g.from, g.to);
    // One deletion for every total row, however many groups there were.
    wb.deleteLines(sheetId, 'row', rows.map((r) => ({ from: r, to: r })), 'Remove subtotals');
  });
  return rows.length;
}
