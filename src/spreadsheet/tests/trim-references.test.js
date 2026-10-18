import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { calc } from './helpers/calc.js';
import { toFileFormula, fromFileFormula } from '../src/core/xlfn.js';

const E = (code) => ({ error: code });

// Excel's trim references put a period beside the range colon to drop blank outer rows and
// columns: A:.A is column A down to its last value, A1.:A100 skips the blanks above, A1.:.B9 both.
// They were a syntax error here, and a workbook saved by Excel with them read #NAME?.
describe('trim references', () => {
  const data = { A3: 1, A4: 2, A6: 4, B4: 'x' };

  it('trim trailing, leading or both outer blank rows and columns', () => {
    expect(calc('SUM(A:.A)', data)).toBe(7);
    expect(calc('ROWS(A:.A)', data)).toBe(6);
    expect(calc('ROWS(A1:.A100)', data)).toBe(6);
    expect(calc('ROWS(A1.:A100)', data)).toBe(98);
    expect(calc('ROWS(A1.:.A100)', data)).toBe(4);
    expect(calc('COLUMNS(A1:.D100)', data)).toBe(2);
    expect(calc('COLUMNS(A1.:.D100)', data)).toBe(2);
    expect(calc('ROWS(Sheet1!$A$1:.$B$50)', data)).toBe(6);
  });

  it('stay references', () => {
    expect(calc('INDEX(ROW(A1.:.A100),1)', data)).toBe(3);
    expect(calc('SUMIF(A:.A,">1")', data)).toBe(6);
    expect(calc('COUNTBLANK(A1.:.A100)', data)).toBe(1);
    expect(calc('ROWS(C:.C)', data)).toEqual(E('#CALC!'));
  });

  it('move with inserted rows and copies, keeping their periods', () => {
    const wb = new Workbook(), id = wb.activeSheetId;
    wb.setInput(id, 0, 0, '1'); wb.setInput(id, 1, 0, '2'); wb.setInput(id, 0, 1, '5'); wb.setInput(id, 0, 3, 'x');
    wb.setInput(id, 0, 2, '=SUM(A1:.A50)+COUNT(B:.B)');
    wb.insertRows(id, 0, 1);
    expect(wb.getCell(id, 1, 2).f).toBe('SUM(A2:.A51)+COUNT(B:.B)');
    expect(wb.getValue(id, 1, 2)).toBe(4);
    wb.fill(id, { r1: 1, c1: 2, r2: 1, c2: 2 }, { r1: 1, c1: 2, r2: 1, c2: 3 });
    expect(wb.getCell(id, 1, 3).f).toBe('SUM(B2:.B51)+COUNT(C:.C)');
  });

  it('are written to workbook files as TRIMRANGE, and read from Excel\'s _TRO_ calls', () => {
    expect(toFileFormula('SUM(A:.A)+ROWS(A1.:.B9)')).toBe('SUM(_xlfn.TRIMRANGE(A:A,2,2))+ROWS(_xlfn.TRIMRANGE(A1:B9,3,3))');
    expect(toFileFormula("SUM('Q1.Data'!A1.:B9)")).toBe("SUM(_xlfn.TRIMRANGE('Q1.Data'!A1:B9,1,1))");
    expect(fromFileFormula('SUM(_xlfn._TRO_TRAILING(A:A))')).toBe('SUM(A:.A)');
    expect(fromFileFormula('_xlfn._TRO_ALL(Sheet1!$A$1:$B$9)*2')).toBe('Sheet1!$A$1.:.$B$9*2');
    expect(fromFileFormula('_xlfn._TRO_LEADING(A1:A9)')).toBe('A1.:A9');
  });

  it('open again from a saved workbook with the same results', async () => {
    const { workbookFromFile, workbookToXlsx } = await import('../src/core/io.js');
    const wb = new Workbook(), id = wb.activeSheetId;
    wb.setInput(id, 2, 0, '1'); wb.setInput(id, 4, 0, '2');
    wb.setInput(id, 0, 2, '=ROWS(A:.A)');
    wb.setInput(id, 1, 2, '=SUMIF(A1.:.A99,">0")');
    const back = await workbookFromFile(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), 'trim.xlsx');
    const sid = back.sheets[0].id;
    expect(back.getValue(sid, 0, 2)).toBe(5);
    expect(back.getValue(sid, 1, 2)).toBe(3);
  });

  it('leave other periods alone', () => {
    expect(calc('A1.5', {})).toEqual(E('#NAME?'));
    expect(toFileFormula('SUM(A1:A9)+1.5')).toBe('SUM(A1:A9)+1.5');
  });
});

describe('TRIMRANGE', () => {
  // TRIMRANGE handed back values only as far as the data was read, so a side it was told to
  // keep lost its extent (ROWS(TRIMRANGE(A:A,0)) counted the used rows), and it was no
  // longer a reference.
  it('keeps the extent of a side left untrimmed, and returns a reference', () => {
    expect(calc('ROWS(TRIMRANGE(A:A,0))', { A1: 1, A5: 2 })).toBe(1048576);
    expect(calc('ROWS(TRIMRANGE(A1:A100,0,0))', { A1: 1 })).toBe(100);
    expect(calc('COLUMNS(TRIMRANGE(A1:D9,3,0))', { A1: 1 })).toBe(4);
    expect(calc('ISREF(TRIMRANGE(A1:A100))', { A1: 1 })).toBe(true);
    expect(calc('ROWS(TRIMRANGE(A1:B100))', { A2: 1, B5: 2 })).toBe(4);
    expect(calc('SUM(TRIMRANGE({1,2;3,4}))')).toBe(10);
  });
});
