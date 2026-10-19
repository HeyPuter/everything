import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// A defined name may share a function's spelling (an interest rate called "rate"), and a call with
// parentheses still means the built-in. Renaming such a name rewrote the calls too: RATE(10,-100,800)
// became interest(10,-100,800) and read #NAME? in every formula that used the function.
describe('renaming a name spelled like a function', () => {
  it('renames the uses of the name and leaves calls to the function alone', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, '0.05');
    wb.defineName('rate', 'Sheet1!$A$1');
    wb.defineName('dbl', '=LAMBDA(x,x*2)');
    wb.setInput(id, 1, 0, '=RATE(10,-100,800)');
    wb.setInput(id, 2, 0, '=LET(n,2,rate*n+ROUND(RATE(10,-100,800),2))');
    wb.setInput(id, 3, 0, '=Sheet1!rate+dbl(2)');
    wb.addRule(id, { type: 'formula', value: '=RATE(10,-100,800)>rate', range: { r1: 0, c1: 1, r2: 3, c2: 1 }, style: { bold: true } });
    const rate = wb.getValue(id, 1, 0);
    expect(wb.renameName('rate', null, 'interest', 'Sheet1!$A$1')).toBeNull();
    expect(wb.getCell(id, 1, 0).f).toBe('RATE(10,-100,800)');
    expect(wb.getValue(id, 1, 0)).toBe(rate);
    expect(wb.getCell(id, 2, 0).f).toBe('LET(n,2,interest*n+ROUND(RATE(10,-100,800),2))');
    expect(wb.getCell(id, 3, 0).f).toBe('Sheet1!interest+dbl(2)');
    expect(wb.sheet(id).rules[0].value).toBe('=RATE(10,-100,800)>interest');
    // A name holding a LAMBDA is called with parentheses, and those calls do follow its rename.
    expect(wb.renameName('dbl', null, 'twice', '=LAMBDA(x,x*2)')).toBeNull();
    expect(wb.getCell(id, 3, 0).f).toBe('Sheet1!interest+twice(2)');
    expect(wb.getValue(id, 3, 0)).toBe(4.05);
  });
});
