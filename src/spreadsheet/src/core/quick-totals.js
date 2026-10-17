/**
 * Quick Analysis ▸ Totals: one-click totals for a selected block, written as live formulas either in
 * the row under it (one per column) or in the column beside it (one per row): Sum, Average, Count, % Total
 * and Running Total.
 */
import { colName } from './cell.js';

export const QUICK_TOTALS = [
  ['sum', 'Sum'], ['average', 'Average'], ['count', 'Count'], ['percent', '% Total'], ['running', 'Running Total'],
];

const ref = (r, c, absR = false, absC = false) => `${absC ? '$' : ''}${colName(c)}${absR ? '$' : ''}${r + 1}`;
const span = (r1, c1, r2, c2, abs = false) => `${ref(r1, c1, abs, abs)}:${ref(r2, c2, abs, abs)}`;

/**
 * The cells to write: [{ r, c, input, style }] or null when the block has no room or no numbers.
 * `direction` 'rows' totals each column in the row below; 'columns' totals each row in the column to the right.
 */
export function quickTotalEntries(wb, sheetId, range, kind, direction) {
  const { r1, c1, r2, c2 } = range;
  // A header row of labels over the numbers is left out of the totals.
  const header = r2 > r1 && [...Array(c2 - c1 + 1).keys()].some((i) => typeof wb.getValue(sheetId, r1, c1 + i) === 'string')
    && ![...Array(c2 - c1 + 1).keys()].some((i) => typeof wb.getValue(sheetId, r1, c1 + i) === 'number');
  const top = header ? r1 + 1 : r1;
  const out = [];
  const bold = { bold: true };
  if (direction === 'rows') {
    const r = r2 + 1;
    for (let c = c1; c <= c2; c++) {
      const col = span(top, c, r2, c);
      let input;
      if (kind === 'sum') input = `=SUM(${col})`;
      else if (kind === 'average') input = `=AVERAGE(${col})`;
      else if (kind === 'count') input = `=COUNT(${col})`;
      else if (kind === 'percent') input = `=SUM(${col})/SUM(${span(top, c1, r2, c2, true)})`;
      // Everything from the block's first column through this one, so the totals build up left to right.
      else if (kind === 'running') input = `=SUM(${ref(top, c1, true, true)}:${ref(r2, c)})`;
      else return null;
      out.push({ r, c, input, style: kind === 'percent' ? { ...bold, fmt: 'percent' } : bold });
    }
  } else {
    const c = c2 + 1;
    for (let r = top; r <= r2; r++) {
      const row = span(r, c1, r, c2);
      let input;
      if (kind === 'sum') input = `=SUM(${row})`;
      else if (kind === 'average') input = `=AVERAGE(${row})`;
      else if (kind === 'count') input = `=COUNT(${row})`;
      else if (kind === 'percent') input = `=SUM(${row})/SUM(${span(top, c1, r2, c2, true)})`;
      else if (kind === 'running') input = `=SUM(${ref(top, c1, true, true)}:${ref(r, c2, false, true)})`;
      else return null;
      out.push({ r, c, input, style: kind === 'percent' ? { ...bold, fmt: 'percent' } : bold });
    }
    // The new column is named in the header row.
    if (header) out.push({ r: r1, c, input: QUICK_TOTALS.find(([k]) => k === kind)[1], style: bold });
  }
  return out;
}
