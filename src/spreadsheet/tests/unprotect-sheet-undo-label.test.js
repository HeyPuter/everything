import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Unprotecting a sheet was recorded under the name "Protect sheet", and unfreezing panes under "Freeze panes",
// so Edit > Undo offered to undo the very thing the user had just taken off.
it('names the protection step after what was done to the sheet', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setSheetProtected(id, true);
  expect(wb.undoLabel()).toBe('Protect sheet');
  wb.setSheetProtected(id, false);
  expect(wb.undoLabel()).toBe('Unprotect sheet');
  wb.undo();
  expect(wb.isProtected(id)).toBe(true);
  expect(wb.redoLabel()).toBe('Unprotect sheet');
});

it('names the frozen panes step after what was done to the sheet', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setFrozen(id, 1, 0);
  expect(wb.undoLabel()).toBe('Freeze panes');
  wb.setFrozen(id, 2, 1);
  expect(wb.undoLabel()).toBe('Freeze panes');
  wb.setFrozen(id, 0, 0);
  expect(wb.undoLabel()).toBe('Unfreeze panes');
  wb.undo();
  expect(wb.activeSheet.frozenRows).toBe(2);
});
