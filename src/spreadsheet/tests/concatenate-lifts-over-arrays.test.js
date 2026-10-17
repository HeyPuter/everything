import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { calc } from './helpers/calc.js';

// CONCATENATE joins single values, so an array argument is joined element by element (and spills),
// where CONCAT runs every cell of a range together.
const D = { A1: 'Ann', A2: 'Bob', A3: 'Cy', B1: 'Lee', B2: 'Ray', B3: 'Oz', C1: '=1/0' };

describe('CONCATENATE', () => {
  it('joins arrays element by element', () => {
    const wb = new Workbook(), id = wb.activeSheetId;
    for (const [r, [a, b]] of [['Ann', 'Lee'], ['Bob', 'Ray'], ['Cy', 'Oz']].entries()) { wb.setInput(id, r, 0, a); wb.setInput(id, r, 1, b); }
    wb.setInput(id, 0, 4, '=CONCATENATE(A1:A3," ",B1:B3)');
    expect([0, 1, 2].map((r) => wb.getValue(id, r, 4))).toEqual(['Ann Lee', 'Bob Ray', 'Cy Oz']);
    expect(calc('ROWS(CONCATENATE(A1:A3,"!"))', D)).toBe(3);
    expect(calc('INDEX(CONCATENATE({"a","b"},{1;2}),2,2)')).toBe('b2');
  });

  it('still joins single values, as CONCAT does a range', () => {
    expect(calc('CONCATENATE("a",1,TRUE)')).toBe('a1TRUE');
    expect(calc('CONCATENATE(A1,"-",B1)', D)).toBe('Ann-Lee');
    expect(calc('CONCATENATE("a",,"b")')).toBe('ab');
    expect(calc('CONCATENATE(A1,C1)', D)).toEqual({ error: '#DIV/0!' });
    expect(calc('CONCAT(A1:A3," ",B1:B3)', D)).toBe('AnnBobCy LeeRayOz');
  });
});
