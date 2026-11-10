import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { ARITY } from '../src/core/formula/arity.js';
import { FUNCTIONS } from '../src/core/formula/functions.js';

// The app took formulas Excel refuses as typed: =ABS(1,2) gave 1, =ROUND(1.5) gave 2 and =NOW(1) the
// time. Excel answers "You've entered too many (too few) arguments for this function", and a saved file
// holding one may make it offer to repair the book. Such an entry now stays the text typed, as one past
// Excel's other limits on functions does; a formula read from a file is still read as it is.
function enter(text, setup) {
  const wb = new Workbook(), id = wb.activeSheetId;
  setup?.(wb, id);
  wb.setInput(id, 0, 0, text);
  return { cell: wb.getCell(id, 0, 0), value: wb.getValue(id, 0, 0) };
}
const kept = (text) => enter(text).cell;

describe('a typed formula giving a function the wrong number of arguments', () => {
  it('stays the text typed', () => {
    for (const text of ['=ABS(1,2)', '=ROUND(1.5)', '=NOW(1)', '=IF(1,2,3,4)', '=INDEX(A1:B2,1,1,1,1)', '=VLOOKUP(1,A1:B2)',
      '=SUM(1,ABS())', '=LET(x,1,ROUND(x))', '=IFERROR(1)']) {
      expect(kept(text), text).toMatchObject({ f: null, v: text });
    }
    // Found at the end of a chain of operators as deep as it is long.
    expect(kept(`=${'1+'.repeat(4000)}ABS(1,2)`).f).toBeNull();
    expect(enter(`=${'1+'.repeat(4000)}ABS(1)`).value).toBe(4001);
  });

  it('is a formula with the arguments Excel takes, empty ones counted', () => {
    expect(enter('=ROUND(1.5,)').value).toBe(2);
    expect(enter('=ROUND(1.5,0)').value).toBe(2);
    expect(enter('=NOW( )').cell.f).toBe('NOW( )');
    expect(enter('=INDEX({1,2;3,4},2,1,1)').value).toBe(3);
    expect(enter('=IF(FALSE,1)').value).toBe(false);
    expect(enter('=SUM()').value).toBe(0);
    expect(enter('=ACCRINT(39508,39691,39569,0.1,1000,2,0,TRUE)').cell.f).not.toBeNull();
    expect(enter('=FORECAST.ETS.CONFINT(4,{1,2,3},{1,2,3})').cell.f).not.toBeNull();
    expect(enter('=ODDLYIELD(39217,39340,39036,0.0375,99.875,100,2)').cell.f).not.toBeNull();
  });

  it('leaves alone a LAMBDA called by a function name, and functions Excel has not got', () => {
    expect(enter('=LET(abs,LAMBDA(a,b,a+b),abs(1,2))').value).toBe(3);
    expect(enter('=MAP({1,2},LAMBDA(round,round(1)))').cell.f).not.toBeNull();
    expect(enter('=LAMBDA(x,y,x+y)(1,2)').value).toBe(3);
    expect(enter('=COUNTUNIQUE(1,2,2)').value).toBe(2);
    expect(enter('=FILTER({1;2;3},{1;0;1},{1;1;0})').cell.f).not.toBeNull();
  });

  it('takes every function in the table at its least and most arguments, and refuses one fewer or more', () => {
    const call = (name, n) => `=${name}(${Array(n).fill('1').join(',')})`;
    for (const [name, [min, max]] of ARITY) {
      expect(FUNCTIONS[name], name).toBeDefined();
      expect(kept(call(name, min)).f, `${name}/${min}`).not.toBeNull();
      if (min > 0) expect(kept(call(name, min - 1)).f, `${name}/${min - 1}`).toBeNull();
      if (max < Infinity) {
        expect(kept(call(name, max)).f, `${name}/${max}`).not.toBeNull();
        expect(kept(call(name, max + 1)).f, `${name}/${max + 1}`).toBeNull();
      }
    }
  });

  it('is still read from a file as it is', async () => {
    const wb = new Workbook(), id = wb.activeSheetId;
    wb.setCells(id, [{ r: 0, c: 0, cell: { v: null, f: 'ROUND(2.5)' } }]);
    const back = await workbookFromFile(await workbookToXlsx(wb), 'round.xlsx');
    expect(back.getCell(back.activeSheetId, 0, 0).f).toBe('ROUND(2.5)');
    expect(back.getValue(back.activeSheetId, 0, 0)).toBe(3);
  });
});
