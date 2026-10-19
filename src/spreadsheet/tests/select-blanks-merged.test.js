import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Go To Special ▸ Blanks selected the cells a merged block covers, which show nothing because the block shows its
// top-left cell alone. The usual next step, typing =A2 and Ctrl+Enter to fill every blank from the row above,
// then wrote values under the merge where nobody could see them. A merged block counts as one cell: blank only
// when its top-left cell is.
describe('Go To Special ▸ Blanks over merged cells', () => {
  it('passes over the cells a merged block covers', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, 'Region');
    wb.setInput(id, 0, 1, 'Amount');
    wb.setInput(id, 1, 0, 'East');
    wb.mergeCells(id, { r1: 1, c1: 0, r2: 3, c2: 0 });
    for (let r = 1; r <= 5; r++) wb.setInput(id, r, 1, String(r));
    wb.setInput(id, 4, 0, 'West');
    wb.mergeCells(id, { r1: 6, c1: 0, r2: 7, c2: 1 }); // a blank merged block is one blank cell
    wb.setInput(id, 8, 1, '9');
    expect(wb.specialCells(id, { r1: 0, c1: 0, r2: 8, c2: 1 }, 'blanks')).toEqual([
      { r1: 5, c1: 0, r2: 6, c2: 0 }, { r1: 8, c1: 0, r2: 8, c2: 0 },
    ]);
  });
});
