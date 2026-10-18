import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { tokenize } from '../src/core/formula/tokenizer.js';

// B1:A1# is the range operator between the cell B1 and the spill of A1, as Excel reads it.
// The tokenizer took B1:A1 as one block carrying #, which only a single cell may carry, so
// the formula was refused as a syntax error, while A1#:B1, the same range written the other
// way round, worked.
describe('a range that ends at a spill reference', () => {
  const setup = (formula) => {
    const wb = new Workbook(), id = wb.activeSheetId;
    wb.setInput(id, 0, 0, '=SEQUENCE(3)'); // A1:A3 holds 1, 2, 3
    wb.setInput(id, 0, 1, '10');
    wb.setInput(id, 0, 3, formula);
    return { wb, id };
  };

  it('covers the block from the cell to the whole spill', () => {
    for (const f of ['=SUM(B1:A1#)', '=SUM(A1:A1#)', '=SUM(C5:A1#)', '=SUM(Sheet1!B1:A1#)', '=SUM($B$1:$A$1#)']) {
      const { wb, id } = setup(f);
      expect(wb.getValue(id, 0, 3)).toBe(f.includes('A1:A1#') ? 6 : 16);
    }
    const { wb, id } = setup('=ROWS(A1:A1#)');
    expect(wb.getValue(id, 0, 3)).toBe(3);
  });

  it('is read as a cell, a colon and a spill', () => {
    expect(tokenize('B1:A1#').map((t) => [t.type, t.text, t.spill])).toEqual([['ref', 'B1', false], ['colon', undefined, undefined], ['ref', 'A1', true]]);
    expect(tokenize('A1:B2').map((t) => [t.type, t.text])).toEqual([['ref', 'A1:B2']]);
  });

  it('moves with inserted rows and filled copies', () => {
    const { wb, id } = setup('=SUM(B1:A1#)');
    wb.insertRows(id, 0, 1);
    expect(wb.getCell(id, 1, 3).f).toBe('SUM(B2:A2#)');
    expect(wb.getValue(id, 1, 3)).toBe(16);
    wb.fill(id, { r1: 1, c1: 3, r2: 1, c2: 3 }, { r1: 1, c1: 3, r2: 2, c2: 3 });
    expect(wb.getCell(id, 2, 3).f).toBe('SUM(B3:A3#)');
  });
});

describe('a range ending at a spill, saved to a workbook file', () => {
  it('writes the spill as ANCHORARRAY on the same sheet as the start cell', async () => {
    const { spillRefsToFile, spillRefsFromFile } = await import('../src/core/refs.js');
    expect(spillRefsToFile('SUM(B1:A1#)')).toBe('SUM(B1:_xlfn.ANCHORARRAY(A1))');
    expect(spillRefsToFile("SUM('My Data'!B1:A1#)")).toBe("SUM('My Data'!B1:_xlfn.ANCHORARRAY('My Data'!A1))");
    expect(spillRefsFromFile('SUM(B1:_xlfn.ANCHORARRAY(A1))')).toBe('SUM(B1:A1#)');
  });

  it('opens again with the same totals', async () => {
    const { workbookFromFile, workbookToXlsx } = await import('../src/core/io.js');
    const wb = new Workbook(), id = wb.activeSheetId;
    const data = wb.addSheet('Data').id;
    wb.setInput(data, 0, 0, '=SEQUENCE(3)'); wb.setInput(data, 0, 1, '10');
    wb.setInput(id, 0, 0, '=SEQUENCE(2)');
    wb.setInput(id, 0, 3, '=SUM(B1:A1#)');
    wb.setInput(id, 1, 3, '=SUM(Data!B1:A1#)');
    const back = await workbookFromFile(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), 'spill.xlsx');
    const sid = back.sheets[0].id;
    expect(back.getValue(sid, 0, 3)).toBe(3);
    expect(back.getValue(sid, 1, 3)).toBe(16);
  });
});
