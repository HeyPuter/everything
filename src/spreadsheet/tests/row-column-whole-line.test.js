import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { calc } from './helpers/calc.js';

// ROW(A:A) and COLUMN(1:1) number the rows (columns) a whole column (row) is read to, standing for
// all of it, so they pair position by position with A:A<>"" and the last-row idioms find the last row.
const D = { A1: '1', A3: 'x', A5: '5', B1: 'a', C1: 'b', E1: 'c' };

describe('ROW and COLUMN of a whole column or row', () => {
  it('finds the last row or column in use', () => {
    expect(calc('LOOKUP(2,1/(A:A<>""),ROW(A:A))', D)).toBe(5);
    expect(calc('LOOKUP(2,1/(A1:A100<>""),ROW(A:A))', D)).toBe(5);
    expect(calc('MAX(IF(A:A<>"",ROW(A:A)))', D)).toBe(5);
    expect(calc('MAX((A:A<>"")*ROW(A:A))', D)).toBe(5);
    expect(calc('SUMPRODUCT((A:A<>"")*ROW(A:A))', D)).toBe(9);
    expect(calc('LOOKUP(2,1/(1:1<>""),COLUMN(1:1))', D)).toBe(5);
    expect(calc('MAX(IF(1:1<>"",COLUMN(1:1)))', D)).toBe(5);
    expect(calc('MAX(IF(Sheet1!A:A<>"",ROW(Sheet1!A:A)))', D)).toBe(5);
  });

  it('is indexed by position and starts at the first row or column named', () => {
    expect(calc('INDEX(ROW(A:A),5)', D)).toBe(5);
    expect(calc('COLUMN(C:D)', D)).toBe(3);
    expect(calc('ROW(3:4)', D)).toBe(3);
  });

  it('spills from a cell over the rows in use', () => {
    const wb = new Workbook(), id = wb.activeSheetId;
    wb.setInput(id, 0, 0, '1'); wb.setInput(id, 4, 0, '5');
    wb.setInput(id, 0, 2, '=ROW(A:A)');
    expect([0, 1, 2, 3, 4].map((r) => wb.getValue(id, r, 2))).toEqual([1, 2, 3, 4, 5]);
    expect(wb.spillRangeAt(id, 0, 2)).toMatchObject({ r1: 0, r2: 4 });
  });

  it('keeps answering the last row as rows are added', () => {
    const wb = new Workbook(), id = wb.activeSheetId;
    wb.setInput(id, 0, 0, '1');
    wb.setInput(id, 0, 3, '=LOOKUP(2,1/(A:A<>""),ROW(A:A))');
    expect(wb.getValue(id, 0, 3)).toBe(1);
    wb.setInput(id, 299, 0, 'x');
    expect(wb.getValue(id, 0, 3)).toBe(300);
    wb.setInput(id, 299, 0, '');
    expect(wb.getValue(id, 0, 3)).toBe(1);
  });
});
