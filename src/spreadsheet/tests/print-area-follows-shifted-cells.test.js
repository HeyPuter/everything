import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Insert ▸ Cells (shift down) inside a print area pushed its last rows below it: the area stayed A1:D20 while the
// data went on to row 22, so the print and the PDF silently left those rows out. Delete ▸ Cells (shift up) left
// blank rows inside it. The print area is a reference (Excel keeps it as the name Print_Area) and now follows
// the shift as references do; print titles and page breaks belong to whole lines and stay where they were.
function setup() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (let r = 0; r < 20; r++) for (let c = 0; c < 4; c++) wb.setInput(id, r, c, String(r + 1));
  wb.setPrintSettings(id, { areas: [{ r1: 0, c1: 0, r2: 19, c2: 3 }, { r1: 0, c1: 6, r2: 4, c2: 7 }], titleRows: [0, 0], rowBreaks: [10] });
  wb.clearHistory();
  return { wb, id, print: () => wb.sheet(id).printSettings };
}

describe('the print area through Insert and Delete cells', () => {
  it('grows over cells shifted down inside it, and undo puts it back', () => {
    const { wb, id, print } = setup();
    expect(wb.insertCells(id, { r1: 4, c1: 0, r2: 5, c2: 3 }, 'down')).toBe(true);
    expect(wb.getValue(id, 21, 0)).toBe(20);
    expect(print().areas).toEqual([{ r1: 0, c1: 0, r2: 21, c2: 3 }, { r1: 0, c1: 6, r2: 4, c2: 7 }]);
    expect(print().titleRows).toEqual([0, 0]);
    expect(print().rowBreaks).toEqual([10]);
    wb.undo();
    expect(print().areas[0]).toEqual({ r1: 0, c1: 0, r2: 19, c2: 3 });
    wb.redo();
    expect(print().areas[0]).toEqual({ r1: 0, c1: 0, r2: 21, c2: 3 });
  });

  it('shrinks when cells inside it are deleted, and goes when all of its cells do', () => {
    const { wb, id, print } = setup();
    expect(wb.deleteCells(id, { r1: 0, c1: 0, r2: 2, c2: 3 }, 'up')).toBe(true);
    expect(print().areas).toEqual([{ r1: 0, c1: 0, r2: 16, c2: 3 }, { r1: 0, c1: 6, r2: 4, c2: 7 }]);
    expect(wb.deleteCells(id, { r1: 0, c1: 6, r2: 4, c2: 7 }, 'left')).toBe(true);
    expect(print().areas).toEqual([{ r1: 0, c1: 0, r2: 16, c2: 3 }]);
  });

  it('stays put when the shift runs through only some of its columns, or beside it', () => {
    const { wb, id, print } = setup();
    expect(wb.insertCells(id, { r1: 4, c1: 0, r2: 4, c2: 1 }, 'down')).toBe(true);
    expect(wb.insertCells(id, { r1: 2, c1: 4, r2: 2, c2: 4 }, 'right')).toBe(true);
    expect(print().areas).toEqual([{ r1: 0, c1: 0, r2: 19, c2: 3 }, { r1: 0, c1: 6, r2: 4, c2: 7 }]);
  });
});
