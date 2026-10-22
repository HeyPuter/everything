import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// REDUCE answers whatever its lambda leaves in the accumulator. One starting as an array, REDUCE({0,0},A1:A3,
// LAMBDA(a,v,a+v)) for a running pair of totals, spills that array in Excel; the app judged the formula by its
// lambda alone, found a+v a single value and answered #VALUE!.
it('spills an accumulator that starts as an array', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  ['1', '2', '3'].forEach((v, r) => wb.setInput(id, r, 0, v));
  wb.setInput(id, 0, 1, '5');
  wb.setInput(id, 0, 2, '6');
  const at = (r, c, formula, rows, cols) => {
    wb.setInput(id, r, c, formula);
    return wb.rangeValues(id, { r1: r, c1: c, r2: r + rows - 1, c2: c + cols - 1 });
  };
  expect(at(10, 0, '=REDUCE({0,0},A1:A3,LAMBDA(a,v,a+v))', 1, 3)).toEqual([[6, 6, null]]);
  expect(at(11, 0, '=REDUCE({0,0},{1,2,3},LAMBDA(a,v,a+v))', 1, 3)).toEqual([[6, 6, null]]);
  expect(at(12, 0, '=REDUCE(B1:C1,SEQUENCE(3),LAMBDA(acc,v,acc*v))', 1, 3)).toEqual([[30, 36, null]]);
  expect(at(13, 0, '=LET(add,LAMBDA(a,v,a+v),REDUCE({1;1},{1,2,3},add))', 3, 1)).toEqual([[7], [7], [null]]);
  // A single value to start with, or a lambda that folds the array away, is one value as before.
  expect(at(20, 0, '=REDUCE(0,A1:A3,LAMBDA(a,v,a+v))', 1, 2)).toEqual([[6, null]]);
  expect(at(21, 0, '=REDUCE({1,2},A1:A3,LAMBDA(a,v,SUM(a)+v))', 1, 2)).toEqual([[9, null]]);
  expect(at(22, 0, '=REDUCE(B1,A1:A3,LAMBDA(a,v,a+v))', 1, 2)).toEqual([[11, null]]);
});

// A LAMBDA defined as a name builds arrays as one written in place does: REDUCE("",A1:A3,Stack) with Stack defined as
// LAMBDA(a,v,VSTACK(a,v)), or LET(g,Double,g({1,2})), answered #VALUE! where Double({1,2}) itself spilled.
it('spills a defined LAMBDA handed to REDUCE or held by a LET name', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  ['x', 'y'].forEach((v, r) => wb.setInput(id, r, 0, v));
  expect(wb.defineName('Stack', '=LAMBDA(a,v,VSTACK(a,v))')).toBeNull();
  expect(wb.defineName('Plus', '=LAMBDA(a,v,a+v)')).toBeNull();
  expect(wb.defineName('Double', '=LAMBDA(x,x*2)')).toBeNull();
  const at = (r, c, formula, rows, cols) => {
    wb.setInput(id, r, c, formula);
    return wb.rangeValues(id, { r1: r, c1: c, r2: r + rows - 1, c2: c + cols - 1 });
  };
  expect(at(10, 0, '=REDUCE("",{"x","y"},Stack)', 3, 1)).toEqual([[''], ['x'], ['y']]);
  expect(at(10, 2, '=REDUCE({0,0},{1,2,3},Plus)', 1, 3)).toEqual([[6, 6, null]]);
  expect(at(10, 6, '=LET(f,Plus,REDUCE({1;1},{1,2},f))', 2, 1)).toEqual([[4], [4]]);
  expect(at(10, 8, '=LET(g,Double,g({1,2}))', 1, 3)).toEqual([[2, 4, null]]);
  expect(at(10, 12, '=REDUCE("",{"x","y"},VSTACK)', 3, 1)).toEqual([[''], ['x'], ['y']]);
  expect(at(20, 0, '=REDUCE(0,{1,2,3},Plus)', 1, 2)).toEqual([[6, null]]);
  expect(at(20, 2, '=LET(g,Double,g(4))', 1, 2)).toEqual([[8, null]]);
  expect(at(20, 4, '=REDUCE(0,{1,2,3},SUM)', 1, 2)).toEqual([[6, null]]);
});
