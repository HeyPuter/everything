import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { findAll, searchBudget } from '../src/core/search.js';

// Find listed every value spilled on the sheet before reading the first of them, so on a sheet holding an array
// formula entered over the whole sheet (seventeen billion results) typing in the Find bar ran the tab out of
// memory, whatever its time budget. It walks the results one at a time, only those inside a search's range.
function book() {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '5');
  wb.setInput(id, 3, 0, 'needle');
  expect(wb.setArrayFormula(id, { r1: 0, c1: 1, r2: 1048575, c2: 16383 }, '=A1*2')).toBe(true);
  return { wb, id };
}

it('stops a search of the whole sheet when its time is spent', () => {
  const { wb, id } = book();
  const budget = searchBudget(300);
  expect(findAll(wb, id, 'needle', { budget })).toEqual([{ r: 3, c: 0 }]);
  expect(budget.exceeded).toBe(true);
});

it('finds the results spilled into a search\'s range', () => {
  const { wb, id } = book();
  const budget = searchBudget(3000);
  expect(findAll(wb, id, '10', { range: { r1: 0, c1: 0, r2: 1, c2: 2 }, budget })).toEqual([{ r: 0, c: 1 }, { r: 0, c: 2 }, { r: 1, c: 1 }, { r: 1, c: 2 }]);
  expect(budget.exceeded).toBe(false);
});
