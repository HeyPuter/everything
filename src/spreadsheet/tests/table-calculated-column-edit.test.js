import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Typing a new formula into a calculated column changed only the cell it was typed in: the other rows kept the old
// formula and rows added later still took it. Excel overwrites the whole column with the new formula when the
// column holds nothing but its formula, and leaves a column with exceptions alone.
function table() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Item', 'Qty', 'Price', 'Tot'], ['a', 1, 10], ['b', 2, 20], ['c', 3, 30]].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  const t = wb.addTable(id, { r1: 0, c1: 0, r2: 3, c2: 3 });
  wb.setInput(id, 1, 3, '=[@Qty]*[@Price]');
  return { wb, id, t };
}
const formulas = (wb, id) => [1, 2, 3].map((r) => wb.getCell(id, r, 3)?.f ?? wb.getValue(id, r, 3));

it('rewrites every row of a calculated column with the new formula, and new rows take it', () => {
  const { wb, id, t } = table();
  wb.setInput(id, 2, 3, '=[@Qty]+[@Price]');
  expect(formulas(wb, id)).toEqual(['[@Qty]+[@Price]', '[@Qty]+[@Price]', '[@Qty]+[@Price]']);
  expect([1, 2, 3].map((r) => wb.getValue(id, r, 3))).toEqual([11, 22, 33]);
  const r = wb.addTableRow(id, t);
  expect(wb.getCell(id, r, 3).f).toBe('[@Qty]+[@Price]');
  wb.undo();
  wb.undo();
  expect(formulas(wb, id)).toEqual(['[@Qty]*[@Price]', '[@Qty]*[@Price]', '[@Qty]*[@Price]']);
});

it('leaves a column with an exception as it is', () => {
  const { wb, id } = table();
  wb.setInput(id, 3, 3, '99');
  wb.setInput(id, 2, 3, '=[@Qty]+[@Price]');
  expect(formulas(wb, id)).toEqual(['[@Qty]*[@Price]', '[@Qty]+[@Price]', 99]);
});
