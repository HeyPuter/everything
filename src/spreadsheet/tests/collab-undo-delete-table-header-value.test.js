import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';

// Deleting the row of a table's header makes its first data row the header, whose cells are text: a number there
// becomes its text. In a shared workbook the undo of a deletion writes back only the cells of the deleted lines and
// the formulas it broke, so the number stayed text ("24", aligned left, out of every sum) after Undo; Undo on a
// workbook of one's own put the number back.
it('puts back a number a table made text in the row that became its header', () => {
  const wb = new Workbook({ sheets: [{ name: 'Sheet1' }] });
  new Replica(wb);
  const s = wb.activeSheetId;
  wb.setInput(s, 7, 0, '24');
  wb.addTable(s, { r1: 6, c1: 0, r2: 8, c2: 1 });
  expect(wb.getValue(s, 7, 0)).toBe(24);
  wb.deleteRows(s, 6, 1);
  expect(wb.getValue(s, 6, 0)).toBe('24');
  wb.undo();
  expect(wb.getValue(s, 7, 0)).toBe(24);
});
