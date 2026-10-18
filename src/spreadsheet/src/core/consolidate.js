/**
 * Data ▸ Consolidate: combine several ranges into one table, cell by cell by position, or by the labels in
 * their top row and/or left column (the union of labels, in the order first seen), with one of the summary functions below.
 */
import { maxOf, minOf } from './numeric.js';

const FUNCS = {
  sum: (xs) => xs.reduce((a, b) => a + b, 0),
  count: (xs, all) => all.length,
  average: (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null),
  max: (xs) => (xs.length ? maxOf(xs) : null),
  min: (xs) => (xs.length ? minOf(xs) : null),
  product: (xs) => (xs.length ? xs.reduce((a, b) => a * b, 1) : null),
  countNums: (xs) => xs.length,
  stdev: (xs) => (xs.length > 1 ? Math.sqrt(variance(xs, 1)) : null),
  stdevp: (xs) => (xs.length ? Math.sqrt(variance(xs, 0)) : null),
  var: (xs) => (xs.length > 1 ? variance(xs, 1) : null),
  varp: (xs) => (xs.length ? variance(xs, 0) : null),
};
function variance(xs, ddof) {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - ddof);
}
export const CONSOLIDATE_FUNCTIONS = [['sum', 'Sum'], ['count', 'Count'], ['average', 'Average'], ['max', 'Max'], ['min', 'Min'], ['product', 'Product'],
  ['countNums', 'Count Numbers'], ['stdev', 'StdDev'], ['stdevp', 'StdDevp'], ['var', 'Var'], ['varp', 'Varp']];

const key = (v) => (typeof v === 'string' ? `s:${v.trim().toLowerCase()}` : `v:${v}`);

/**
 * The values of one reference, as consolidate takes them: every row and column of it the sheet has data in (a whole
 * column reads down to the sheet's last row, not a million blank ones), errors as blanks. Null for an unknown sheet.
 */
export function consolidationSource(wb, sheetId, range) {
  if (!wb.sheet(sheetId)) return null;
  const used = wb.usedRange(sheetId);
  if (!used) return [];
  const r2 = Math.min(range.r2, used.r2), c2 = Math.min(range.c2, used.c2);
  const rows = [];
  for (let r = range.r1; r <= r2; r++) {
    const row = [];
    for (let c = range.c1; c <= c2; c++) { const v = wb.getValue(sheetId, r, c); row.push(v && typeof v === 'object' ? null : v); }
    rows.push(row);
  }
  return rows;
}

/**
 * sources: arrays of rows of values. Returns rows of values for the result, labels included where asked for
 * (the top-left corner blank when both are used), or null when there is nothing to combine.
 */
export function consolidate(sources, { fn = 'sum', topRow = false, leftColumn = false } = {}) {
  const f = FUNCS[fn] || FUNCS.sum;
  const grids = sources.filter((g) => g?.length && g[0]?.length);
  if (!grids.length) return null;
  const rowLabels = [], colLabels = [], rowIndex = new Map(), colIndex = new Map();
  const cells = new Map(); // "row|col" → values
  const at = (label, list, index) => {
    const k = key(label);
    if (!index.has(k)) { index.set(k, list.length); list.push(label); }
    return index.get(k);
  };
  for (const g of grids) {
    const r0 = topRow ? 1 : 0, c0 = leftColumn ? 1 : 0;
    for (let r = r0; r < g.length; r++) {
      const rowLabel = leftColumn ? g[r][0] : null;
      if (leftColumn && (rowLabel == null || rowLabel === '')) continue;
      const ri = leftColumn ? at(rowLabel, rowLabels, rowIndex) : r - r0;
      for (let c = c0; c < g[r].length; c++) {
        const colLabel = topRow ? g[0][c] : null;
        if (topRow && (colLabel == null || colLabel === '')) continue;
        const ci = topRow ? at(colLabel, colLabels, colIndex) : c - c0;
        const cell = `${ri}|${ci}`;
        if (!cells.has(cell)) cells.set(cell, []);
        const v = g[r][c];
        if (v != null && v !== '') cells.get(cell).push(v);
      }
    }
  }
  let rows = leftColumn ? rowLabels.length : 0, cols = topRow ? colLabels.length : 0;
  for (const cell of cells.keys()) { const [ri, ci] = cell.split('|').map(Number); rows = Math.max(rows, ri + 1); cols = Math.max(cols, ci + 1); }
  if (!rows || !cols) return null;
  const out = [];
  if (topRow) out.push([...(leftColumn ? [null] : []), ...colLabels]);
  for (let ri = 0; ri < rows; ri++) {
    const row = leftColumn ? [rowLabels[ri]] : [];
    for (let ci = 0; ci < cols; ci++) {
      const all = cells.get(`${ri}|${ci}`) || [];
      const nums = all.filter((v) => typeof v === 'number');
      row.push(all.length ? f(nums, all) : null);
    }
    out.push(row);
  }
  return out;
}
