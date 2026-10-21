import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Rows hidden from under a list to the sheet's end (Ctrl+Shift+Down from a row header, then Hide) are a million
// numbers in every structural step's undo snapshot, about 8 MB each, but the history weighed its snapshots by
// their cells alone: a few hundred cells, so all 200 steps were kept and inserting rows a few dozen times held a
// gigabyte. The hidden lines now count towards the budget (an eighth of a cell each), so the oldest steps make way.
describe('structural undo on a sheet with rows hidden to its end', () => {
  it('keeps the history within the budget and still undoes the steps it keeps', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    for (let r = 0; r < 20; r++) wb.setInput(id, r, 0, String(r + 1));
    expect(wb.setHidden(id, 'row', Array.from({ length: 1048576 - 30 }, (_, i) => i + 30), true)).toBe(true);
    wb.clearHistory();
    for (let k = 0; k < 12; k++) wb.insertRows(id, 0, 1);
    expect(wb._history.length).toBeLessThan(12);
    expect(wb._snapshotCells).toBeLessThanOrEqual(1_000_000);
    expect(wb.getValue(id, 12, 0)).toBe(1);
    expect(wb.isHidden(id, 'row', 42)).toBe(true);
    expect(wb.isHidden(id, 'row', 41)).toBe(false);
    wb.undo();
    expect(wb.getValue(id, 11, 0)).toBe(1);
    expect(wb.isHidden(id, 'row', 41)).toBe(true);
  });
});
