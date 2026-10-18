import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { calc } from './helpers/calc.js';

/** The block a formula in A1 spills, read until the first blank row and column. */
function spill(formula) {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, `=${formula}`);
  const out = [];
  for (let r = 0; wb.getValue(id, r, 0) != null; r++) {
    const row = [];
    for (let c = 0; wb.getValue(id, r, c) != null; c++) row.push(wb.getValue(id, r, c));
    out.push(row);
  }
  return out;
}

// Every argument of SEQUENCE left out defaults to 1, rows included: SEQUENCE(,3) is one row of three.
it('takes one row when rows is left empty', () => {
  expect(spill('SEQUENCE(,3)')).toEqual([[1, 2, 3]]);
  expect(spill('SEQUENCE(,3,10,-2)')).toEqual([[10, 8, 6]]);
  expect(calc('SEQUENCE(,,5)')).toBe(5);
  expect(calc('SUM(SEQUENCE(,4))')).toBe(10);
});

it('keeps a zero or negative row count an empty array', () => {
  expect(calc('SEQUENCE(0,3)')).toEqual({ error: '#CALC!' });
  expect(calc('SEQUENCE(-1)')).toEqual({ error: '#CALC!' });
  expect(spill('SEQUENCE(2,,3)')).toEqual([[3], [4]]);
});
