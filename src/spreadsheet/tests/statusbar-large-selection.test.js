import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { summarize, summarizeAll } from '../src/ui/statusbar.js';

const COLUMN = { r1: 0, c1: 0, r2: 1048575, c2: 0 };
const SHEET = { r1: 0, c1: 0, r2: 1048575, c2: 16383 };

function sheetOf(rows, value = (r) => r + 1) {
  return new Workbook({ sheets: [{ name: 'S', rows: 1048576, cols: 16384, cells: Object.fromEntries(
    Array.from({ length: rows }, (_, r) => [[`${r},0`, { v: value(r) }], [`${r},1`, { v: 'x' }]]).flat(),
  ) }] });
}

it('sums a whole column of more than 20,000 numbers', () => {
  const rows = 30000;
  const wb = sheetOf(rows);
  const id = wb.activeSheetId;
  wb.usedRange(id);
  expect(summarize(wb, id, COLUMN)).toMatchObject({ count: rows, nums: rows, sum: rows * (rows + 1) / 2, min: 1, max: rows });
  expect(summarize(wb, id, SHEET)).toMatchObject({ count: rows * 2, nums: rows });
  expect(summarizeAll(wb, id, [COLUMN, { r1: 0, c1: 1, r2: 1048575, c2: 1 }])).toMatchObject({ count: rows * 2, nums: rows });
});

it('reads only the stored cells of a whole column, even when the total overflows', () => {
  const wb = sheetOf(3, () => 1e308);
  wb.setInput(wb.activeSheetId, 3, 0, '=A1');
  const id = wb.activeSheetId;
  let reads = 0;
  const getValue = wb.getValue.bind(wb);
  wb.getValue = (...args) => { reads++; return getValue(...args); };
  const s = summarize(wb, id, COLUMN);
  expect(s).toMatchObject({ count: 4, nums: 4 });
  expect(s.sum).not.toBeNaN();
  // Only the formula is asked of the workbook; plain values are read straight from their cells.
  expect(reads).toBeLessThan(10);
});

it('still gives up on a sheet too large to summarise in one go', () => {
  const wb = sheetOf(210000);
  expect(summarize(wb, wb.activeSheetId, SHEET)).toBeNull();
});
