import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// A record typed in the row just under a filtered list joins the list, as it does in Excel: left out of the
// filter's range, its value was missing from the filter menu, and filtering for "a" afterwards left the new
// "b" row showing among the a's.
function book({ table = false } = {}) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Key', 'Value'], ['a', 1], ['b', 2], ['a', 3]].forEach((row, r) => row.forEach((v, c) => wb.setCells(id, [{ r, c, cell: { v } }])));
  if (table) wb.addTable(id, { r1: 0, c1: 5, r2: 1, c2: 6 });
  wb.setFilterRange(id, { r1: 0, c1: 0, r2: 3, c2: 1 });
  wb.clearHistory();
  return { wb, id };
}

it.each([false, true])('takes a row typed under the list into the filter (a table elsewhere: %s)', (table) => {
  const { wb, id } = book({ table });
  wb.setInput(id, 4, 0, 'b');
  wb.setInput(id, 4, 1, '9');
  expect(wb.sheet(id).filter.range).toEqual({ r1: 0, c1: 0, r2: 4, c2: 1 });
  expect(wb.filterValues(id, 0).map((v) => `${v.value}:${v.count}`)).toEqual(['a:2', 'b:2']);
  wb.setFilterCriteria(id, 0, { values: ['a'] });
  expect([...wb.sheet(id).filterHidden].sort()).toEqual([2, 4]);
});

it('leaves the new row in view while the filter stays as it was, and undo takes the row back out', () => {
  const { wb, id } = book();
  wb.setFilterCriteria(id, 0, { values: ['a'] });
  wb.clearHistory();
  wb.setInput(id, 4, 0, 'b');
  expect(wb.sheet(id).filterHidden.has(4)).toBe(false);
  expect(wb.sheet(id).filter.range.r2).toBe(4);
  expect(wb.undoLabels()).toHaveLength(1);
  wb.undo();
  expect(wb.getValue(id, 4, 0)).toBe(null);
  expect(wb.sheet(id).filter.range.r2).toBe(3);
  wb.redo();
  expect(wb.sheet(id).filter.range.r2).toBe(4);
});

it('does not grow for an entry beside the list or further down', () => {
  const { wb, id } = book();
  wb.setInput(id, 4, 2, 'x');
  wb.setInput(id, 6, 0, 'y');
  expect(wb.sheet(id).filter.range.r2).toBe(3);
});
