import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseCellRef } from '../src/core/cell.js';

/** The column a formula in D1 spills, over A1:A4 = 3, 1, 3, "x" and B1:B4 = 10, 20, 30, 40. */
function column(formula, rows = 4) {
  const wb = new Workbook(), id = wb.activeSheetId;
  const cells = { A1: '3', A2: '1', A3: '3', A4: 'x', B1: '10', B2: '20', B3: '30', B4: '40', D1: `=${formula}` };
  for (const [a1, text] of Object.entries(cells)) { const { r, c } = parseCellRef(a1); wb.setInput(id, r, c, text); }
  return Array.from({ length: rows }, (_, r) => wb.getValue(id, r, 3));
}

// MAP over a range hands its LAMBDA each cell as a reference, so the running-total and running-count
// idioms that build a range up to the cell (A1:x) work, as do ROW, OFFSET and other reference readers.
it('hands the LAMBDA each cell of a range as a reference', () => {
  expect(column('MAP(B1:B4,LAMBDA(x,SUM(B1:x)))')).toEqual([10, 30, 60, 100]);
  expect(column('MAP(A1:A3,LAMBDA(x,COUNTIF(A1:x,x)))', 3)).toEqual([1, 1, 2]);
  expect(column('MAP(A1:A4,LAMBDA(x,ROW(x)))')).toEqual([1, 2, 3, 4]);
  expect(column('MAP(A1:A4,LAMBDA(x,ISREF(x)))')).toEqual([true, true, true, true]);
  expect(column('MAP(A1:A3,LAMBDA(x,OFFSET(x,0,1)))', 3)).toEqual([10, 20, 30]);
  expect(column('MAP(A1:A3,B1:B3,LAMBDA(a,b,a*b))', 3)).toEqual([30, 20, 90]);
});

it('still hands the values of an array, and reads each cell as before', () => {
  expect(column('MAP({1;2;3},LAMBDA(x,x*2))', 3)).toEqual([2, 4, 6]);
  expect(column('MAP(A1:A4,LAMBDA(x,x))')).toEqual([3, 1, 3, 'x']);
  expect(column('MAP(A1:A4,LAMBDA(x,ISTEXT(x)))')).toEqual([false, false, false, true]);
  expect(column('MAP(A1:A4,LAMBDA(x,LEN(x)&TYPE(x)))')).toEqual(['11', '11', '11', '12']);
  expect(column('MAP(A1:A3*2,LAMBDA(x,x+1))', 3)).toEqual([7, 3, 7]);
});

it('hands a reference wherever the LAMBDA reads its parameter as one, even beside operators', () => {
  expect(column('MAP(B1:B4,LAMBDA(x,x+SUM(B1:x)))')).toEqual([20, 50, 90, 140]);
  expect(column('MAP(A1:A4,LAMBDA(x,-ROW(x)%))')).toEqual([-0.01, -0.02, -0.03, -0.04]);
  expect(column('MAP(B1:B3,LAMBDA(x,LET(y,x,SUM(B1:y))))', 3)).toEqual([10, 30, 60]);
  expect(column('MAP(B1:B3,LAMBDA(x,MAP(x,LAMBDA(y,ROW(y)))*x))', 3)).toEqual([10, 40, 90]);
});
