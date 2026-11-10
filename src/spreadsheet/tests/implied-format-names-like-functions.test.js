import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// A defined name spelled like a function (Rate, PV, Today) was taken for a call of that function
// when a formula was typed: =Rate*2 with Rate defined as 5 showed 1,000.00% instead of 10, and
// =Rate alone 500.00%. A name written without parentheses calls nothing; it carries the format of
// the cells it stands for, as any other name does.
it.each([
  ['=Rate*2', '10'],
  ['=Rate', '5'],
  ['=PV+1', '6'],
  ['=Today', '5'],
])('shows %s over names spelled like functions as %s', (formula, shown) => {
  const wb = new Workbook(), id = wb.activeSheetId;
  for (const name of ['Rate', 'PV', 'Today']) wb.defineName(name, '=5');
  wb.setInput(id, 0, 0, formula);
  expect(wb.getCell(id, 0, 0).s?.fmt).toBeUndefined();
  expect(wb.getDisplay(id, 0, 0)).toBe(shown);
});

it('still takes the format of the cells such a name stands for, and of a real call', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 1, '25%');
  wb.defineName('Rate', '=Sheet1!$B$1');
  wb.setInput(id, 0, 0, '=Rate');
  expect(wb.getDisplay(id, 0, 0)).toBe('25%');
  wb.setInput(id, 1, 0, '=RATE(10,-100,800)');
  expect(wb.getDisplay(id, 1, 0)).toBe('4.28%');
});

// TODAY and NOW take no arguments, so =TODAY and =NOW written bare still call them where no name
// has their spelling, and the cell still reads as a date rather than as 46328.
it.each([
  ['=TODAY', 'date'],
  ['=NOW', 'datetime'],
  ['=TODAY+1', 'date'],
])('still dates %s with no name of that spelling', (formula, fmt) => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, formula);
  expect(wb.getCell(id, 0, 0).s?.fmt).toBe(fmt);
});
