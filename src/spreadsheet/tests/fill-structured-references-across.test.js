import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// A formula over a table filled right kept naming the same column: =SUM(Table1[Qty]) dragged across gave the Qty
// total under Price and Disc too, and =[@Qty]*2 filled right inside a table stayed [@Qty]*2. Excel moves a
// one-column structured reference along the table's columns when a formula is filled across, and keeps the span
// form Table1[[Qty]:[Qty]] fixed, which is how a structured reference is made absolute.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Item', 'Qty', 'Price', 'Disc'], ['a', 1, 10, 5], ['b', 2, 20, 6], ['c', 3, 30, 7]].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  wb.addTable(id, { r1: 0, c1: 0, r2: 3, c2: 3 });
  return { wb, id };
}

it('moves a column reference along the table when filled right, and keeps the span form fixed', () => {
  const { wb, id } = book();
  wb.setInput(id, 6, 1, '=SUM(Table1[Qty])');
  wb.fill(id, { r1: 6, c1: 1, r2: 6, c2: 1 }, { r1: 6, c1: 1, r2: 6, c2: 3 });
  expect([1, 2, 3].map((c) => wb.getValue(id, 6, c))).toEqual([6, 60, 18]);
  expect(wb.getCell(id, 6, 2).f).toBe('SUM(Table1[Price])');
  wb.setInput(id, 7, 1, '=SUM(Table1[[Qty]:[Qty]])');
  wb.fillDirection(id, { r1: 7, c1: 1, r2: 7, c2: 2 }, 'right');
  expect(wb.getCell(id, 7, 2).f).toBe('SUM(Table1[[Qty]:[Qty]])');
  // Filled down, nothing moves; past the table's last column, the reference stays as it was.
  wb.fill(id, { r1: 6, c1: 1, r2: 6, c2: 1 }, { r1: 6, c1: 1, r2: 8, c2: 1 });
  expect(wb.getCell(id, 8, 1).f).toBe('SUM(Table1[Qty])');
  wb.fill(id, { r1: 6, c1: 3, r2: 6, c2: 3 }, { r1: 6, c1: 3, r2: 6, c2: 4 });
  expect(wb.getCell(id, 6, 4).f).toBe('SUM(Table1[Disc])');
});

it('moves a this-row reference inside the table', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Item', 'Qty', 'Price', 'A', 'B'], ['a', 1, 10], ['b', 2, 20]].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  wb.addTable(id, { r1: 0, c1: 0, r2: 2, c2: 4 });
  wb.setInput(id, 1, 3, '=[@Qty]*2');
  wb.fill(id, { r1: 1, c1: 3, r2: 1, c2: 3 }, { r1: 1, c1: 3, r2: 1, c2: 4 });
  expect(wb.getCell(id, 1, 4).f).toBe('[@Price]*2');
  expect(wb.getValue(id, 1, 4)).toBe(20);
});
