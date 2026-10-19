import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Copying the results of a What-If data table and pasting them elsewhere laid down {=TABLE(,J8)}, an array reading
// cells that were never the table's input, so the pasted cells showed 0; a copy of part of the results even moved
// the input cell (TABLE(,G1) became TABLE(,G2)). Excel pastes the values the table shows, and so does the app now.
it('pastes the values a data table shows, whole or in part', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 6, '5');
  wb.setInput(id, 1, 1, '=G1*10');
  [1, 2, 3].forEach((v, i) => wb.setInput(id, 2 + i, 0, String(v)));
  wb.createDataTable(id, { r1: 1, c1: 0, r2: 4, c2: 1 }, null, { r: 0, c: 6 });
  expect(wb.rangeValues(id, { r1: 2, c1: 1, r2: 4, c2: 1 })).toEqual([[10], [20], [30]]);

  wb.pasteCells(id, wb.copyRange(id, { r1: 2, c1: 1, r2: 4, c2: 1 }, { sameBook: true }), 9, 4, { r: 2, c: 1 });
  expect(wb.rangeValues(id, { r1: 9, c1: 4, r2: 11, c2: 4 })).toEqual([[10], [20], [30]]);
  expect(wb.getCell(id, 9, 4).f ?? null).toBe(null);

  wb.pasteCells(id, wb.copyRange(id, { r1: 3, c1: 1, r2: 4, c2: 1 }, { sameBook: true }), 14, 4, { r: 3, c: 1 });
  expect(wb.rangeValues(id, { r1: 14, c1: 4, r2: 15, c2: 4 })).toEqual([[20], [30]]);
  // The table itself is untouched and still follows its input.
  wb.setInput(id, 0, 6, '7');
  expect(wb.rangeValues(id, { r1: 2, c1: 1, r2: 4, c2: 1 })).toEqual([[10], [20], [30]]);
  expect(wb.getCell(id, 2, 1).f).toMatch(/^TABLE\(/);
});
