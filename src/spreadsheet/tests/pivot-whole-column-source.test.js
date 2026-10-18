import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseCellRef } from '../src/core/cell.js';
import { buildPivot, pivotRangeProblem } from '../src/core/pivot.js';

function data(rows = [['Region', 'Amount'], ['East', 10], ['West', 5], ['East', 7]]) {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const id = wb.activeSheetId;
  rows.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  return { wb, id };
}

it('takes whole columns, or a range kept roomy for rows to come, as the data they hold', () => {
  const { wb, id } = data();
  const whole = wb.rangeFromText(id, 'A:B').range;
  expect(pivotRangeProblem(wb, id, whole)).toBeNull();
  expect(pivotRangeProblem(wb, id, { r1: 0, c1: 0, r2: 69999, c2: 1 })).toBeNull();
  expect(pivotRangeProblem(wb, id, { r1: 0, c1: 0, r2: 0, c2: 1 })).toMatch(/header row and at least one row/);
  expect(pivotRangeProblem(wb, id, { r1: 3, c1: 0, r2: 1000, c2: 1 })).toMatch(/header row and at least one row/);

  const built = buildPivot(wb, id, { range: whole, rowField: 0, colField: null, valueField: 1, agg: 'sum', filters: [] });
  // The empty rows under the data are no "(blank)" category.
  expect(built.rowCount).toBe(2);
  const pivot = wb.addSheet('Pivot');
  wb.setCells(pivot.id, built.cells, 'Pivot');
  const at = (a1) => { const { r, c } = parseCellRef(a1); return wb.getValue(pivot.id, r, c); };
  expect([at('A2'), at('B2'), at('A3'), at('B3'), at('A4'), at('B4')]).toEqual(['East', 17, 'West', 5, 'Total', 22]);
  // A row added under the data counts in its category, as the formulas name the whole columns.
  wb.setInput(id, 4, 0, 'West');
  wb.setInput(id, 4, 1, '20');
  expect([at('B3'), at('B4')]).toEqual([25, 42]);
});

it('says how many rows of data a range too large holds, and the most a pivot table takes', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: 'K' } }, { r: 0, c: 1, cell: { v: 'V' } }, ...Array.from({ length: 60000 }, (_, i) => ({ r: i + 1, c: 0, cell: { v: `k${i % 9}` } }))]);
  expect(pivotRangeProblem(wb, id, wb.rangeFromText(id, 'A:B').range)).toBe('That range holds 60,000 rows of data; a pivot table summarizes up to 50,000');
});
