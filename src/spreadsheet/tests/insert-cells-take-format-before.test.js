import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Insert ▸ Cells inside a formatted block left a hole of unformatted cells: a currency column with a fill got two
// General, unfilled cells in its middle, where Excel formats inserted cells the same as the cells above (shift down)
// or to the left (shift right), as this app already does for inserted rows and columns. The cells inserted now take
// the style of the cell before them, never its value; a merged block and a table's header row lend none, and cells
// inserted from the clipboard keep their own.
function setup() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (let r = 0; r < 5; r++) { wb.setInput(id, r, 0, `Item ${r + 1}`); wb.setInput(id, r, 1, String((r + 1) * 100)); }
  wb.applyStyle(id, { r1: 0, c1: 1, r2: 4, c2: 1 }, { fmt: 'currency', bg: '#fff2cc' });
  wb.clearHistory();
  return { wb, id };
}

describe('cells inserted inside a formatted block', () => {
  it('take the formatting of the cells above when shifted down, and lose it again on undo', () => {
    const { wb, id } = setup();
    expect(wb.insertCells(id, { r1: 2, c1: 0, r2: 3, c2: 1 }, 'down')).toBe(true);
    for (const r of [2, 3]) {
      expect(wb.getCell(id, r, 1)).toEqual({ v: null, f: null, s: { fmt: 'currency', bg: '#fff2cc' } });
      expect(wb.getValue(id, r, 0)).toBeNull();
    }
    expect(wb.getValue(id, 4, 1)).toBe(300);
    wb.setInput(id, 2, 1, '250');
    expect(wb.getDisplay(id, 2, 1)).toBe(wb.getDisplay(id, 1, 1).replace('200', '250'));
    wb.undo(); wb.undo();
    expect(wb.getCell(id, 2, 1)).toMatchObject({ v: 300, s: { fmt: 'currency' } });
    expect(wb.sheet(id).cells.size).toBe(10);
  });

  it('take the formatting of the cell to the left when shifted right', () => {
    const { wb, id } = setup();
    expect(wb.insertCells(id, { r1: 1, c1: 2, r2: 1, c2: 2 }, 'right')).toBe(true);
    expect(wb.getCell(id, 1, 2)).toEqual({ v: null, f: null, s: { fmt: 'currency', bg: '#fff2cc' } });
  });

  it('take nothing in the first row, nor from a merged block or a table header', () => {
    const { wb, id } = setup();
    expect(wb.insertCells(id, { r1: 0, c1: 1, r2: 0, c2: 1 }, 'down')).toBe(true);
    expect(wb.getCell(id, 0, 1)).toBeUndefined();
    wb.mergeCells(id, { r1: 0, c1: 3, r2: 0, c2: 4 });
    wb.applyStyle(id, { r1: 0, c1: 3, r2: 0, c2: 4 }, { bold: true });
    expect(wb.insertCells(id, { r1: 1, c1: 3, r2: 1, c2: 4 }, 'down')).toBe(true);
    expect(wb.getCell(id, 1, 3)).toBeUndefined();
    wb.addTable(id, { r1: 10, c1: 0, r2: 12, c2: 1 }, {});
    wb.applyStyle(id, { r1: 10, c1: 0, r2: 10, c2: 1 }, { bold: true });
    expect(wb.insertCells(id, { r1: 11, c1: 0, r2: 11, c2: 1 }, 'down')).toBe(true);
    expect(wb.styleAt(id, 11, 0)?.bold).toBeFalsy();
  });
});
