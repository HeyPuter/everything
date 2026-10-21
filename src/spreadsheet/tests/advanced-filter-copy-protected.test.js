import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { advancedFilter } from '../src/core/advanced-filter.js';

// An Advanced Filter copying to a protected place (another sheet that is protected, or a protected range) wrote
// nothing, the protection refusing it, yet reported the records as copied ("3 records copied"). The copy is now
// refused with a reason the dialog shows, and nothing is written.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Name', 'Qty'], ['a', 1], ['b', 2], ['a', 3]].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  return { wb, id, list: { r1: 0, c1: 0, r2: 3, c2: 1 } };
}

it('refuses to copy onto a protected sheet', () => {
  const { wb, id, list } = book();
  const out = wb.addSheet('Out');
  wb.setSheetProtected(out.id, true);
  expect(advancedFilter(wb, id, { list, copyTo: { sheetId: out.id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } } }).error).toMatch(/protected/);
  expect(wb.getValue(out.id, 0, 0)).toBeNull();
});

it('refuses to copy over a protected range, and copies once the place is free', () => {
  const { wb, id, list } = book();
  wb.protectRange(id, { r1: 2, c1: 5, r2: 2, c2: 5 });
  expect(advancedFilter(wb, id, { list, copyTo: { range: { r1: 0, c1: 5, r2: 0, c2: 5 } } }).error).toMatch(/protected/);
  expect(wb.getValue(id, 0, 5)).toBeNull();
  expect(advancedFilter(wb, id, { list, copyTo: { range: { r1: 0, c1: 8, r2: 0, c2: 8 } } })).toEqual({ copied: 3, columns: 2 });
  expect(wb.getValue(id, 3, 8)).toBe('a');
});
