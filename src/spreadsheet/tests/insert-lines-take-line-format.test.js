import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// An inserted column took its left neighbour's format only in the rows the sheet had reached: the cells there
// were lent their styles, but the neighbour's whole-column format stayed behind, so a number typed lower down in
// the new column beside a currency column, once the sheet was scrolled there, showed as a plain number. Excel's
// new lines take the whole format of the line before them; rows do the same here now.
const wholeCol = (wb, id, c) => ({ r1: 0, c1: c, r2: wb.sheet(id).rows - 1, c2: c });
const wholeRow = (wb, id, r) => ({ r1: r, c1: 0, r2: r, c2: wb.sheet(id).cols - 1 });

describe('lines inserted after a formatted whole line', () => {
  it('a new column takes the whole-column format on its left, beyond the rows reached', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.applyStyle(id, wholeCol(wb, id, 1), { fmt: 'currency', cur: 'USD' });
    const before = wb.toJSON();
    wb.insertCols(id, 2, 2);
    expect(wb.sheet(id).colStyles.get(3)).toEqual({ fmt: 'currency', cur: 'USD' });
    wb.undo();
    expect(wb.toJSON()).toEqual(before);
    wb.redo();
    wb.ensureSize(id, 400, 30);
    for (const c of [1, 2, 3]) expect(wb.styleAt(id, 350, c)).toMatchObject({ fmt: 'currency', cur: 'USD' });
    expect(wb.styleAt(id, 350, 4)).toBeUndefined();
    wb.setInput(id, 350, 2, '5');
    expect(wb.getDisplay(id, 350, 2)).toBe('$5.00');
  });

  it('a new row takes the whole-row format above it, beyond the columns reached', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.applyStyle(id, wholeRow(wb, id, 0), { bold: true });
    wb.insertRows(id, 1, 1);
    wb.ensureSize(id, 100, 60);
    expect(wb.styleAt(id, 1, 50)).toMatchObject({ bold: true });
    expect(wb.styleAt(id, 2, 50)).toBeUndefined();
  });

  it('a line inserted at the very start has nothing before it to take from', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.applyStyle(id, wholeCol(wb, id, 0), { italic: true });
    wb.insertCols(id, 0, 1);
    expect(wb.sheet(id).colStyles.has(0)).toBe(false);
    expect(wb.sheet(id).colStyles.get(1)).toEqual({ italic: true });
  });
});
