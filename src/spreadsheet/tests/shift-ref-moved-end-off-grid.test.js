import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { shiftFormula } from '../src/core/refs.js';

// Copying a formula checked only a range's start against the top and left edges and its end against the
// bottom and right: a mixed range whose relative end moved off the grid was written as a malformed
// reference (SUM($A$3:A0), SUM($C:)) that then failed to parse, instead of #REF!.
describe('a copied range whose moved end leaves the grid', () => {
  it('becomes #REF!, whichever end moved', () => {
    expect(shiftFormula('SUM($A$3:A5)', -5, 0)).toBe('SUM(#REF!)');
    expect(shiftFormula('SUM($C:C)', 0, -3)).toBe('SUM(#REF!)');
    expect(shiftFormula('SUM(A1048570:$A$1048576)', 10, 0)).toBe('SUM(#REF!)');
    expect(shiftFormula('SUM(XFA1:$XFD$1)', 0, 10)).toBe('SUM(#REF!)');
    expect(shiftFormula('SUM($A$3:A5)', -2, 0)).toBe('SUM($A$3:A3)');
  });

  it('shows #REF! when pasted or filled there', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    for (let r = 0; r < 5; r++) wb.setInput(id, r, 0, String(r + 1));
    wb.setInput(id, 5, 1, '=SUM($A$3:A5)');
    wb.pasteCells(id, wb.copyRange(id, { r1: 5, c1: 1, r2: 5, c2: 1 }), 0, 1, { r: 5, c: 1 });
    expect(wb.getCell(id, 0, 1).f).toBe('SUM(#REF!)');
    expect(wb.getValue(id, 0, 1)).toEqual({ error: '#REF!' });
    wb.setInput(id, 0, 6, '=SUM($E:F)');
    wb.fill(id, { r1: 0, c1: 6, r2: 0, c2: 6 }, { r1: 0, c1: 0, r2: 0, c2: 6 });
    expect(wb.getCell(id, 0, 0).f).toBe('SUM(#REF!)');
  });
});
