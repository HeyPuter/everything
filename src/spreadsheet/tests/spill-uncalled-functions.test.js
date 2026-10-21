import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';

// A formula answering an array of functions, =HSTACK(SUM,MAX) or =IF({1,0},SUM,MAX), showed #CALC! in its
// own cell, but the cells it spilled into held the function itself: they read #VALUE!, B1+1 answered
// #VALUE!, and ISERROR(B1) answered FALSE beside a cell showing an error. Every cell of the spill is now
// #CALC!, as Excel shows a function left uncalled.
const CALC = { error: '#CALC!' };

it('spills #CALC! into every cell an uncalled function lands in', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '=HSTACK(SUM,MAX)');
  wb.setInput(id, 2, 0, '=IF({1,0},SUM,MAX)');
  wb.setInput(id, 4, 0, '=VSTACK(LAMBDA(x,x),1)');
  expect([wb.getValue(id, 0, 0), wb.getValue(id, 0, 1), wb.getValue(id, 2, 1)]).toEqual([CALC, CALC, CALC]);
  expect(wb.getDisplay(id, 0, 1)).toBe('#CALC!');
  expect(wb.getValue(id, 5, 0)).toBe(1);
  wb.setInput(id, 10, 0, '=B1+1');
  wb.setInput(id, 11, 0, '=ISERROR(B1)');
  wb.setInput(id, 12, 0, '=ERROR.TYPE(B1)');
  wb.setInput(id, 13, 0, '=COUNTA(A1#)');
  expect([10, 11, 12, 13].map((r) => wb.getValue(id, r, 0))).toEqual([CALC, true, 14, 2]);
});

it('does the same in a legacy array formula', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setArrayFormula(id, parseRange('A1:B1'), '=HSTACK(SUM,MAX)');
  expect([wb.getValue(id, 0, 0), wb.getValue(id, 0, 1)]).toEqual([CALC, CALC]);
});
