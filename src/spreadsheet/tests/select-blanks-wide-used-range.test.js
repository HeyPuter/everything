import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Go To Special ▸ Blanks gave up on a range of more than 400,000 cells and answered that there were none. From one
// cell it looks over the used range, so a 20,000-row list with a label typed off to its side in column Z said
// "No blank cells" while its own column B had thousands. The blanks are now the gaps between what each column
// holds, found from the sheet's entries, however large the range.
describe('Go To Special ▸ Blanks over a large used range', () => {
  it('finds the blanks of a long list that has an entry far to its side', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    const entries = [];
    for (let r = 0; r < 20000; r++) {
      entries.push({ r, c: 0, cell: { v: `Name ${r}`, f: null } });
      if (r !== 7 && r !== 8 && r !== 15000) entries.push({ r, c: 1, cell: { v: r, f: null } });
    }
    entries.push({ r: 0, c: 25, cell: { v: 'Checked by', f: null } });
    wb.setCells(id, entries, 'seed');
    const used = wb.usedRange(id);
    expect(used).toEqual({ r1: 0, c1: 0, r2: 19999, c2: 25 });
    const blanks = wb.specialCells(id, used, 'blanks');
    expect(blanks.slice(0, 3)).toEqual([
      { r1: 7, c1: 1, r2: 8, c2: 1 }, { r1: 15000, c1: 1, r2: 15000, c2: 1 }, { r1: 0, c1: 2, r2: 19999, c2: 2 },
    ]);
    expect(blanks.at(-1)).toEqual({ r1: 1, c1: 25, r2: 19999, c2: 25 });
    expect(blanks).toHaveLength(26);
    expect(blanks.truncated).toBeUndefined();
  });

  it('stays quick and marks the list cut short when the used range spans the whole grid', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, 'a');
    wb.setCells(id, [{ r: 1048575, c: 16383, cell: { v: 1, f: null } }], 'far');
    const started = performance.now();
    const blanks = wb.specialCells(id, wb.usedRange(id), 'blanks');
    expect(performance.now() - started).toBeLessThan(1000);
    expect(blanks).toHaveLength(500);
    expect(blanks.truncated).toBe(true);
    expect(blanks.slice(0, 2)).toEqual([{ r1: 1, c1: 0, r2: 1048575, c2: 0 }, { r1: 0, c1: 1, r2: 1048575, c2: 1 }]);
  });

  it('still passes over spilled results, array formulas and the cells a merge covers', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, '=SEQUENCE(3)');
    wb.setArrayFormula(id, { r1: 0, c1: 1, r2: 1, c2: 1 }, '=A1:A2*2');
    wb.mergeCells(id, { r1: 3, c1: 1, r2: 4, c2: 2 });
    wb.setInput(id, 5, 2, 'x');
    expect(wb.specialCells(id, { r1: 0, c1: 0, r2: 5, c2: 2 }, 'blanks')).toEqual([
      { r1: 3, c1: 0, r2: 5, c2: 0 }, { r1: 2, c1: 1, r2: 3, c2: 1 }, { r1: 5, c1: 1, r2: 5, c2: 1 }, { r1: 0, c1: 2, r2: 2, c2: 2 },
    ]);
  });
});
