import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// View ▸ Page Breaks (the dashed lines in Normal view) is a view switch, not an undo step, but undoing or redoing
// a structural edit made before it was turned on put back the sheet as it was then, switch and all: the page break
// lines vanished on Ctrl+Z of an inserted row, and came back off on Ctrl+Y. The switch now stays as it is set.
it('keeps the page break lines on or off through the undo and redo of a structural edit', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (let r = 0; r < 6; r++) wb.setInput(id, r, 0, String(r));
  wb.insertRows(id, 2, 1);
  wb.setShowPageBreaks(id, true);
  wb.undo();
  expect(wb.getValue(id, 2, 0)).toBe(2);
  expect(wb.sheet(id).showPageBreaks).toBe(true);
  wb.redo();
  expect(wb.getValue(id, 2, 0)).toBeNull();
  expect(wb.sheet(id).showPageBreaks).toBe(true);
  wb.setShowPageBreaks(id, false);
  wb.undo();
  expect(wb.sheet(id).showPageBreaks).toBeUndefined();
});
