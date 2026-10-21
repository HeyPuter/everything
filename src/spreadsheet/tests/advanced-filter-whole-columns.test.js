import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { advancedFilter, reapplySheetFilters } from '../src/core/advanced-filter.js';

// An Advanced Filter over a list typed as whole columns ($A:$B) judged every one of its million rows: in place it
// took seconds and hid every blank row under the data (the sheet seemed to end there), and a copy took the blank
// rows for a record. The records now stop where the sheet's data does; the list is kept whole, for Reapply.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Name', 'Qty'], ['a', 1], ['b', 2], ['a', 3]].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  wb.setInput(id, 0, 5, 'Name');
  wb.setInput(id, 1, 5, 'a');
  return { wb, id };
}
const WHOLE = { r1: 0, c1: 0, r2: 1048575, c2: 1 };

it('hides only the records that miss the criteria, not the blank rows under a whole-column list', () => {
  const { wb, id } = book();
  const started = performance.now();
  expect(advancedFilter(wb, id, { list: WHOLE, criteria: { range: { r1: 0, c1: 5, r2: 1, c2: 5 } } })).toEqual({ shown: 2, hidden: 1 });
  expect(performance.now() - started).toBeLessThan(1000);
  expect([...wb.sheet(id).hiddenRows]).toEqual([2]);
  // A record added under the data is judged by Reapply, the list being the whole columns still.
  wb.setInput(id, 4, 0, 'b');
  reapplySheetFilters(wb, id);
  expect([...wb.sheet(id).hiddenRows].sort()).toEqual([2, 4]);
});

it('copies the unique records of a whole-column list without a blank one', () => {
  const { wb, id } = book();
  expect(advancedFilter(wb, id, { list: WHOLE, copyTo: { range: { r1: 0, c1: 8, r2: 0, c2: 8 } }, unique: true })).toEqual({ copied: 3, columns: 2 });
  expect(wb.rangeValues(id, { r1: 0, c1: 8, r2: 4, c2: 9 })).toEqual([['Name', 'Qty'], ['a', 1], ['b', 2], ['a', 3], [null, null]]);
});
