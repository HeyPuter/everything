import { describe, expect, it } from 'vitest';
import { applyFixedDecimal, listExtension } from '../src/core/entry-options.js';
import { Workbook } from '../src/core/workbook.js';

describe('a fixed decimal point', () => {
  it('goes into whole numbers typed without one', () => {
    expect(applyFixedDecimal('1234', 2)).toBe('12.34');
    expect(applyFixedDecimal('5', 2)).toBe('0.05');
    expect(applyFixedDecimal('-75', 1)).toBe('-7.5');
    expect(applyFixedDecimal('+120', 3)).toBe('0.120');
    expect(applyFixedDecimal('42', 2, ',')).toBe('0,42');
  });

  it('adds zeros for negative places', () => {
    expect(applyFixedDecimal('5', -2)).toBe('500');
    expect(applyFixedDecimal('007', -1)).toBe('70');
  });

  it('leaves everything else as typed', () => {
    for (const text of ['12.5', '=A1', "'123", 'abc', '1,234', '']) expect(applyFixedDecimal(text, 2)).toBe(text);
    expect(applyFixedDecimal('123', 0)).toBe('123');
  });
});

describe('carrying a list on to a new row', () => {
  function list() {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    for (let r = 0; r < 4; r++) {
      wb.setInput(id, r, 0, `Item ${r}`);
      wb.setInput(id, r, 1, String(10 * (r + 1)));
      wb.setInput(id, r, 2, `=B${r + 1}*2`);
      wb.applyStyle(id, { r1: r, c1: 1, r2: r, c2: 1 }, { bold: true });
    }
    return { wb, id };
  }

  it('offers the shared format and the repeated formula', () => {
    const { wb, id } = list();
    wb.setInput(id, 4, 1, '50');
    const { style, formulas } = listExtension(wb, id, 4, 1);
    expect(style).toMatchObject({ bold: true });
    expect(formulas).toEqual([{ c: 2, input: '=B5*2' }]);
  });

  it('offers nothing above the foot of a short list, or for a formula typed', () => {
    const { wb, id } = list();
    wb.setInput(id, 2, 1, '7');
    expect(listExtension(wb, id, 1, 1)).toEqual({ style: null, formulas: [] });
    wb.setInput(id, 4, 1, '=1+1');
    expect(listExtension(wb, id, 4, 1)).toEqual({ style: null, formulas: [] });
  });

  it('keeps a cell’s own format, and leaves formulas that differ', () => {
    const { wb, id } = list();
    wb.setInput(id, 2, 2, '=B3*3');
    wb.setInput(id, 4, 1, '50');
    wb.applyStyle(id, { r1: 4, c1: 1, r2: 4, c2: 1 }, { italic: true });
    expect(listExtension(wb, id, 4, 1)).toEqual({ style: null, formulas: [] });
  });
});
