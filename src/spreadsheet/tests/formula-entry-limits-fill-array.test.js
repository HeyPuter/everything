import { describe, expect, it } from 'vitest';
import { Workbook, MAX_FORMULA_LENGTH } from '../src/core/workbook.js';

// A formula Excel refuses as typed — =ABS(1,2), SUM of 300 arguments, functions nested 70 deep, one
// longer than 8,192 characters — stays the text typed when entered into one cell. Ctrl+Enter over a
// selection and Ctrl+Shift+Enter as an array took it as a formula all the same, which a saved file
// then held for Excel to call damaged. Ctrl+Enter now writes the text typed into every cell, as
// Enter does into one, and an array entry is refused, its entry left open to be put right.
const REFUSED = [
  '=ABS(1,2)',
  '=ROUND(1.5)',
  `=SUM(${Array(300).fill(1).join(',')})`,
  `=${'ABS('.repeat(70)}-1${')'.repeat(70)}`,
  `="${'x'.repeat(MAX_FORMULA_LENGTH)}"`,
];
const AREA = { r1: 0, c1: 0, r2: 1, c2: 1 };

describe('a formula Excel refuses', () => {
  it.each(REFUSED.map((t) => [t.slice(0, 24), t]))('stays the text typed in every cell Ctrl+Enter fills (%s)', (_, text) => {
    const wb = new Workbook(), id = wb.activeSheetId;
    wb.fillInput(id, AREA, text, { r: 0, c: 0 }, { typed: true });
    for (const [r, c] of [[0, 0], [0, 1], [1, 0], [1, 1]]) expect(wb.getCell(id, r, c)).toMatchObject({ v: text, f: null });
  });

  it.each(REFUSED.map((t) => [t.slice(0, 24), t]))('is refused as an array formula (%s)', (_, text) => {
    const wb = new Workbook(), id = wb.activeSheetId;
    const said = [];
    wb.addEventListener('change', (e) => { if (e.detail?.type === 'array-edit') said.push(e.detail.reason); });
    expect(wb.setArrayFormula(id, AREA, text)).toBe(false);
    expect(wb.getCell(id, 0, 0)).toBeFalsy();
    // One too long to be a formula at all was refused before, and is said so as before.
    expect(said).toEqual([text.length > MAX_FORMULA_LENGTH ? 'formula' : 'limits']);
  });

  it('is still a formula when Excel takes it, shifted from the typed cell', () => {
    const wb = new Workbook(), id = wb.activeSheetId;
    wb.fillInput(id, AREA, '=ROUND(C1,)', { r: 0, c: 0 }, { typed: true });
    expect(wb.getCell(id, 1, 1).f).toBe('ROUND(D2,)');
    expect(wb.setArrayFormula(id, { r1: 3, c1: 0, r2: 4, c2: 0 }, '=ROUND({1.5;2.5},0)')).toBe(true);
    expect(wb.getValue(id, 4, 0)).toBe(3);
  });
});
