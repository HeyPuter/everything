import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { advancedFilter, clearSheetFilters, reapplySheetFilters, sheetHasFiltering } from '../src/core/advanced-filter.js';

// An advanced filter run in place was remembered as row numbers outside the workbook: the rows it hid and the
// list it read. Filtering a list in place, deleting the records shown and choosing Data ▸ Clear (Excel's way of
// deleting the matching records) showed the wrong rows and left the rest of the list hidden while saying the
// filters were cleared; a row inserted above did the same, and Reapply then filtered rows that were not the list.
// The filter is kept on its sheet now, where its list and criteria follow inserted, deleted and moved rows.
const REGIONS = ['East', 'West', 'East', 'West', 'East', 'West', 'West', 'West'];

function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const entries = [{ r: 0, c: 0, cell: { v: 'Region' } }, { r: 0, c: 1, cell: { v: 'Amt' } }];
  REGIONS.forEach((v, i) => entries.push({ r: i + 1, c: 0, cell: { v } }, { r: i + 1, c: 1, cell: { v: i } }));
  entries.push({ r: 0, c: 4, cell: { v: 'Region' } }, { r: 1, c: 4, cell: { v: 'East' } });
  wb.setCells(id, entries);
  advancedFilter(wb, id, { list: parseRange('A1:B9'), criteria: { range: parseRange('E1:E2') } });
  const hidden = () => [...wb.sheet(id).hiddenRows].sort((a, b) => a - b);
  expect(hidden()).toEqual([2, 4, 6, 7, 8]);
  return { wb, id, hidden };
}

it('shows the rest of the list again after the records shown are deleted', () => {
  const { wb, id, hidden } = book();
  wb.deleteLines(id, 'row', [{ from: 1, to: 1 }, { from: 3, to: 3 }, { from: 5, to: 5 }]); // the three East records
  expect(hidden()).toEqual([1, 2, 3, 4, 5]);
  expect(sheetHasFiltering(wb, id)).toBe(true);
  expect(clearSheetFilters(wb, id)).toBe(true);
  expect(hidden()).toEqual([]);
  expect(sheetHasFiltering(wb, id)).toBe(false);
  wb.undo(); // Clear is one step, and takes the filter back with the rows it hid
  expect(hidden()).toEqual([1, 2, 3, 4, 5]);
  expect(sheetHasFiltering(wb, id)).toBe(true);
});

it('clears and reapplies over the list where rows inserted above it moved it', () => {
  const { wb, id, hidden } = book();
  wb.insertRows(id, 0, 3);
  expect(hidden()).toEqual([5, 7, 9, 10, 11]);
  // A record changed to East is taken in by Reapply, at the list's new place.
  wb.setInput(id, 10, 0, 'East');
  expect(reapplySheetFilters(wb, id)).toBe(true);
  expect(hidden()).toEqual([5, 7, 9, 11]);
  expect(clearSheetFilters(wb, id)).toBe(true);
  expect(hidden()).toEqual([]);
});

it('is one undo step with the filter, and a deleted list or criteria range is not reapplied', () => {
  const { wb, id, hidden } = book();
  wb.undo();
  expect(hidden()).toEqual([]);
  expect(sheetHasFiltering(wb, id)).toBe(false);
  wb.redo();
  expect(hidden()).toEqual([2, 4, 6, 7, 8]);
  wb.deleteCols(id, 4, 1); // the criteria
  expect(reapplySheetFilters(wb, id)).toBe(false);
  expect(hidden()).toEqual([2, 4, 6, 7, 8]);
  expect(clearSheetFilters(wb, id)).toBe(true);
  expect(hidden()).toEqual([]);
  // The state is saved with the sheet.
  const again = book();
  const copy = new Workbook(again.wb.toJSON());
  expect(clearSheetFilters(copy, copy.activeSheetId)).toBe(true);
  expect(copy.sheet(copy.activeSheetId).hiddenRows.size).toBe(0);
});
