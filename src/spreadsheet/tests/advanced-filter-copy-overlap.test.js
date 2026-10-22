import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { advancedFilter } from '../src/core/advanced-filter.js';

// Advanced Filter's Copy To wrote the extract wherever it was told, over the list itself included: copying the "a"
// records to B3 overwrote half the list with its own header and records. A destination over the list or the criteria
// range is now refused, and nothing is written.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['K', 'V'], ['a', '1'], ['b', '2'], ['a', '3'], ['c', '4']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  wb.setInput(id, 0, 5, 'K'); wb.setInput(id, 1, 5, 'a');
  wb.clearHistory();
  return { wb, id, list: { r1: 0, c1: 0, r2: 4, c2: 1 }, criteria: { range: { r1: 0, c1: 5, r2: 1, c2: 5 } } };
}

it('refuses to copy the records over the list or the criteria', () => {
  const { wb, id, list, criteria } = book();
  const before = JSON.stringify(wb.rangeValues(id, { r1: 0, c1: 0, r2: 6, c2: 6 }));
  expect(advancedFilter(wb, id, { list, criteria, copyTo: { range: { r1: 2, c1: 1, r2: 2, c2: 1 } } }).error).toMatch(/overlaps the list range/);
  expect(advancedFilter(wb, id, { list, criteria, copyTo: { range: { r1: 0, c1: 4, r2: 0, c2: 4 } } }).error).toMatch(/overlaps the criteria range/);
  expect(JSON.stringify(wb.rangeValues(id, { r1: 0, c1: 0, r2: 6, c2: 6 }))).toBe(before);
  expect(wb.undoLabels()).toEqual([]);
});

it('copies beside the list as before', () => {
  const { wb, id, list, criteria } = book();
  expect(advancedFilter(wb, id, { list, criteria, copyTo: { range: { r1: 0, c1: 2, r2: 0, c2: 2 } } })).toEqual({ copied: 2, columns: 2 });
  expect(wb.rangeValues(id, { r1: 0, c1: 2, r2: 2, c2: 3 })).toEqual([['K', 'V'], ['a', 1], ['a', 3]]);
});
