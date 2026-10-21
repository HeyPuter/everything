import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseCellRef } from '../src/core/cell.js';

// Excel's LINEST leaves out an x variable that is constant, or a combination of the others (the dummy
// variable trap: one column per category beside the intercept), and reports it with a coefficient and a
// standard error of 0, fitting the rest. LINEST, TREND, LOGEST and GROWTH answered #DIV/0! for the whole fit.
function arr(formula) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const cells = { A1: 1, A2: 2, A3: 3, A4: 4, A5: 5, B1: 2, B2: 4.1, B3: 5.9, B4: 8.2, B5: 9.9, C1: 1, C2: 0, C3: 1, C4: 0, C5: 1 };
  for (const [a1, v] of Object.entries(cells)) { const { r, c } = parseCellRef(a1); wb.setInput(id, r, c, String(v)); }
  wb.setInput(id, 0, 9, `=${formula}`);
  const range = wb.spillRangeAt(id, 0, 9) || { r1: 0, c1: 9, r2: 0, c2: 9 };
  return wb.rangeValues(id, range).map((row) => row.map((v) => (typeof v === 'number' ? Number(v.toPrecision(12)) : v)));
}

it('leaves a redundant variable out with a coefficient of 0 and fits the others', () => {
  // The fit of B on A alone is y = 1.99x + 0.05.
  expect(arr('LINEST(B1:B5,A1:A5)')).toEqual([[1.99, 0.05]]);
  expect(arr('LINEST(B1:B5,HSTACK(A1:A5,2*A1:A5))')).toEqual([[0, 1.99, 0.05]]);
  expect(arr('LINEST(B1:B5,HSTACK(A1:A5,{1;1;1;1;1}))')).toEqual([[0, 1.99, 0.05]]);
  // A constant x beside the intercept: only the mean is left.
  expect(arr('LINEST(B1:B5,{3;3;3;3;3})')).toEqual([[0, 6.02]]);
  expect(arr('TREND(B1:B5,{3;3;3;3;3},7)')).toEqual([[6.02]]);
  // C and 1 - C are the dummy variable trap.
  expect(arr('LINEST(B1:B5,HSTACK(A1:A5,C1:C5,1-C1:C5))')[0][0]).toBe(0);
});

it('reports the left-out variable with a standard error of 0 and counts only the others', () => {
  const stats = arr('LINEST(B1:B5,HSTACK(A1:A5,2*A1:A5),TRUE,TRUE)');
  expect(stats[0]).toEqual([0, 1.99, 0.05]);
  expect(stats[1][0]).toBe(0);
  expect(stats[1][1]).toBeCloseTo(0.0472581562625, 10);
  expect(stats[3][1]).toBe(3); // degrees of freedom: five points less one slope and the intercept
  expect(stats[3][0]).toBeCloseTo(1773.17910448, 6); // F over the one variable used
});
