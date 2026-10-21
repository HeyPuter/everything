import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Hiding the rows from under a list to the sheet's end hands the workbook a million row numbers in order, and it put
// them all in a set of their own to drop repeats there could not be before hiding any: about a third of the Hide.
// A list in order is taken as it is; any other still has its repeats dropped.
it('hides a million rows listed in order without copying the list into a set, and drops repeats from any other', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const rows = Array.from({ length: 1048576 - 30 }, (_, i) => i + 30);
  let walked = 0;
  rows[Symbol.iterator] = function () { walked++; return Array.prototype.values.call(this); };
  expect(wb.setHidden(id, 'row', rows, true)).toBe(true);
  expect(walked).toBe(0);
  expect(wb.sheet(id).hiddenRows.size).toBe(1048576 - 30);
  expect(wb.setHidden(id, 'row', [5, 3, 5, 3, 7], true)).toBe(true);
  expect(wb.sheet(id).hiddenRows.size).toBe(1048576 - 30 + 3);
  wb.undo();
  expect(wb.isHidden(id, 'row', 3) || wb.isHidden(id, 'row', 5) || wb.isHidden(id, 'row', 7)).toBe(false);
  wb.undo();
  expect(wb.sheet(id).hiddenRows.size).toBe(0);
  wb.redo();
  expect(wb.isHidden(id, 'row', 30) && wb.isHidden(id, 'row', 1048575) && !wb.isHidden(id, 'row', 29)).toBe(true);
});
