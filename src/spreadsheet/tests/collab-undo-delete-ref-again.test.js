import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';

// In a shared workbook the undo of a deletion writes back the formulas the deletion turned to #REF!, but only those
// that held no #REF! before: one that had lost a reference already (A7+#REF!) and lost another to the deletion
// stayed #REF!+#REF! after Undo. Undo on a workbook of one's own put it back.
it('puts back a formula that lost one more reference to the deletion', () => {
  const wb = new Workbook({ sheets: [{ name: 'Sheet1' }] });
  new Replica(wb);
  const s = wb.activeSheetId;
  wb.setInput(s, 1, 0, '=A7+B8');
  wb.deleteRows(s, 7, 2);
  expect(wb.getCell(s, 1, 0).f).toBe('A7+#REF!');
  wb.deleteRows(s, 6, 2);
  expect(wb.getCell(s, 1, 0).f).toBe('#REF!+#REF!');
  wb.undo();
  expect(wb.getCell(s, 1, 0).f).toBe('A7+#REF!');
  wb.undo();
  expect(wb.getCell(s, 1, 0).f).toBe('A7+B8');
});
