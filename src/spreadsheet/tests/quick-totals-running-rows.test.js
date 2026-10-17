import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { quickTotalEntries } from '../src/core/quick-totals.js';

// Running Total in the row under a block wrote each column's plain sum, the same as Sum. Like the column
// beside a block, it now adds up everything so far: each column's total includes the columns before it.
it('writes running totals in the row under a block that build up left to right', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Q1', 'Q2', 'Q3'], ['10', '20', '30'], ['1', '2', '3']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const entries = quickTotalEntries(wb, id, { r1: 0, c1: 0, r2: 2, c2: 2 }, 'running', 'rows');
  expect(entries.map((e) => [e.r, e.c, e.input])).toEqual([[3, 0, '=SUM($A$2:A3)'], [3, 1, '=SUM($A$2:B3)'], [3, 2, '=SUM($A$2:C3)']]);
  entries.forEach((e) => wb.setInput(id, e.r, e.c, e.input));
  expect([0, 1, 2].map((c) => wb.getValue(id, 3, c))).toEqual([11, 33, 66]);
  // The plain Sum is unchanged.
  expect(quickTotalEntries(wb, id, { r1: 0, c1: 0, r2: 2, c2: 2 }, 'sum', 'rows').map((e) => e.input)).toEqual(['=SUM(A2:A3)', '=SUM(B2:B3)', '=SUM(C2:C3)']);
});
