import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Delete Cells was made again on every grouped sheet, but Insert Cells was not, so the other sheets of the
// group fell out of step with the active one.
describe('Insert cells on grouped sheets', () => {
  it('shifts the same cells on every sheet of the group, as one undo step', () => {
    const wb = new Workbook();
    const a = wb.activeSheetId;
    const b = wb.addSheet('Two').id;
    wb.setActiveSheet(a);
    for (const id of [a, b]) for (let r = 0; r < 3; r++) wb.setInput(id, r, 0, `row${r + 1}`);
    wb.groupSheets([a, b]);
    const before = wb.toJSON();
    expect(wb.insertCells(a, { r1: 0, c1: 0, r2: 0, c2: 0 }, 'down')).toBe(true);
    for (const id of [a, b]) {
      expect(wb.getValue(id, 0, 0)).toBeNull();
      expect(wb.getValue(id, 1, 0)).toBe('row1');
      expect(wb.getValue(id, 3, 0)).toBe('row3');
    }
    expect(wb.undoLabels()[0]).toBe('Insert cells (grouped sheets)');
    wb.undo();
    expect(wb.toJSON()).toEqual(before);
  });
});
