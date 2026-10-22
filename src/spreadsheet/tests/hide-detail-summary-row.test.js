import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { addSubtotals } from '../src/core/subtotal.js';
import { toggleDetail } from '../src/core/outline-detail.js';

// After Subtotal, Hide Detail with the cell on a subtotal row ("East Total") collapsed the grand total's group,
// which holds that row too, hiding every region at once. As in Excel, a summary row stands for its own group:
// Hide Detail there collapses that region's rows, and from a detail row it still collapses the group holding it.
function report() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Region', 'Units'], ['East', '1'], ['East', '2'], ['West', '3'], ['West', '4']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  addSubtotals(wb, id, { r1: 0, c1: 0, r2: 4, c2: 1 }, { groupCol: 0, totalCols: [1] });
  return { wb, id, hidden: () => [...wb.sheet(id).hiddenRows].sort((a, b) => a - b) };
}

it('collapses the subtotal’s own rows from its summary row', () => {
  const { wb, id, hidden } = report();
  expect(wb.getValue(id, 3, 0)).toBe('East Total');
  expect(toggleDetail(wb, id, { active: { r: 3, c: 1 } }, false)).toBe(true);
  expect(hidden()).toEqual([1, 2]);
  expect(toggleDetail(wb, id, { active: { r: 3, c: 1 } }, true)).toBe(true);
  expect(hidden()).toEqual([]);
});

it('collapses the group holding a detail row, and the whole list from the grand total row', () => {
  const { wb, id, hidden } = report();
  expect(toggleDetail(wb, id, { active: { r: 4, c: 0 } }, false)).toBe(true);
  expect(hidden()).toEqual([4, 5]);
  expect(wb.getValue(id, 7, 0)).toBe('Grand Total');
  expect(toggleDetail(wb, id, { active: { r: 7, c: 0 } }, false)).toBe(true);
  expect(hidden()).toEqual([1, 2, 3, 4, 5, 6]);
});
