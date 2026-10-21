import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { summarize, summarizeAll } from '../src/ui/statusbar.js';

// The status bar listed every value spilled anywhere on the sheet to total a selection, so on a sheet holding
// an array formula entered over the whole sheet (seventeen billion results) selecting any two cells ran the tab
// out of memory. It reads only what spills into the selection, once that is known to be few enough to read.
function book() {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '5');
  expect(wb.setArrayFormula(id, { r1: 0, c1: 1, r2: 1048575, c2: 16383 }, '=A1*2')).toBe(true);
  return { wb, id };
}

it('totals a selection on a sheet with an array over the whole sheet', () => {
  const { wb, id } = book();
  expect(summarize(wb, id, { r1: 0, c1: 0, r2: 1, c2: 1 })).toMatchObject({ sum: 25, count: 3, nums: 3, min: 5, max: 10 });
  expect(summarizeAll(wb, id, [{ r1: 4, c1: 3, r2: 5, c2: 3 }, { r1: 0, c1: 0, r2: 0, c2: 0 }])).toMatchObject({ sum: 25, count: 3 });
});

it('leaves the totals out when the selection takes in more of the array than the bar reads', () => {
  const { wb, id } = book();
  expect(summarize(wb, id, { r1: 0, c1: 0, r2: 1048575, c2: 16383 })).toBeNull();
  expect(summarize(wb, id, { r1: 0, c1: 0, r2: 1048575, c2: 0 })).toMatchObject({ sum: 5, count: 1 });
});

it('counts what spills into a range without listing it', () => {
  const { wb, id } = book();
  expect(wb.spillCount(id, { r1: 0, c1: 0, r2: 1, c2: 1 })).toBe(1);
  expect(wb.spillCount(id, { r1: 0, c1: 0, r2: 1048575, c2: 16383 })).toBe(1048576 * 16383 - 1);
  expect(wb.spillCount(id, { r1: 2, c1: 0, r2: 3, c2: 0 })).toBe(0);
});
