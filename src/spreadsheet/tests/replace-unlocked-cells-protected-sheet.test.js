import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { findAll, replaceCells } from '../src/core/search.js';

// On a protected sheet a cell whose Locked box is off may still be typed into, and Excel's Replace
// changes it. Replace skipped every match on a protected sheet, unlocked cells included, as protected.
describe('replacing on a protected sheet', () => {
  it('replaces in unlocked cells and leaves the locked ones alone', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    ['cat', 'cat', 'cat'].forEach((text, r) => wb.setInput(id, r, 0, text));
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 1, c2: 0 }, { locked: false });
    wb.protectRange(id, { r1: 1, c1: 0, r2: 1, c2: 0 }, 'kept');
    wb.setSheetProtected(id, true);
    const skipped = [];
    expect(replaceCells(wb, id, findAll(wb, id, 'cat'), 'cat', 'dog', { skipped })).toBe(1);
    expect([0, 1, 2].map((r) => wb.getValue(id, r, 0))).toEqual(['dog', 'cat', 'cat']);
    expect(skipped).toEqual([{ r: 1, c: 0, reason: 'protected' }, { r: 2, c: 0, reason: 'protected' }]);
    wb.undo();
    expect(wb.getValue(id, 0, 0)).toBe('cat');
  });
});
