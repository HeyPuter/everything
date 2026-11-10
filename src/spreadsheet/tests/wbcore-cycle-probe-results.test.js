import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseCellRef } from '../src/core/cell.js';

// A circle whose cells keep their answers is judged by calculating a cell again with the circle's
// other cells read as blank. Whatever that calculation reached for the first time, or read as a
// range, was kept as the answer for the rest of the calculation: C1 = SUM(B1:B20) beside the
// circle A1/B1 summed B1 as blank (7, not 8), and D1 = B1+100 showed 100 beside B1 = 1, while the
// same cells read in another order gave the right sums.

function book(cells = {}) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const api = {
    wb, id,
    set: (a1, text) => { const { r, c } = parseCellRef(a1); wb.setInput(id, r, c, text); },
    val: (a1) => { const { r, c } = parseCellRef(a1); return wb.getValue(id, r, c); },
  };
  for (const [a1, text] of Object.entries(cells)) api.set(a1, text);
  return api;
}

describe('the calculation that judges a circle', () => {
  it('leaves a range it read with the circle blank out of what other formulas read', () => {
    const cells = { A1: '=COUNTIF(B1:B20,"<>5")', B1: '=COUNTIF(A1,"<>1")', B2: '7', C1: '=SUM(B1:B20)' };
    for (const order of [['A1', 'B1', 'C1'], ['C1', 'A1', 'B1'], ['B1', 'C1', 'A1']]) {
      const b = book(cells);
      const got = Object.fromEntries(order.map((a1) => [a1, b.val(a1)]));
      expect(got, order.join(' ')).toEqual({ A1: 20, B1: 1, C1: 8 });
    }
  });

  it('leaves a cell it reached only with the circle blank to be calculated for real', () => {
    const b = book({ A1: '=IF(ISNUMBER(B1),5,IF(ISNUMBER(D1),5,5))', B1: '=COUNTIF(A1,"<>1")', D1: '=B1+100' });
    expect(b.val('A1')).toBe(5);
    expect(b.val('B1')).toBe(1);
    expect(b.val('D1')).toBe(101);
  });
});
