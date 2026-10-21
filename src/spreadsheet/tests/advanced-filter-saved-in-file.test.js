import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookToXlsx, workbookFromFile } from '../src/core/io.js';
import { advancedFilter, clearSheetFilters, reapplySheetFilters, sheetHasFiltering } from '../src/core/advanced-filter.js';

// An Advanced Filter run in place was forgotten when the file was saved: opened again, its rows stayed hidden but
// Data ▸ Clear said nothing was filtered and left them so, and Reapply did nothing. The filter's list and criteria
// now travel in the app's own part of the file, the criteria's sheet by name.
async function reopened(build) {
  const wb = new Workbook();
  build(wb);
  return workbookFromFile(await workbookToXlsx(wb), 'book.xlsx');
}
function list(wb, id) {
  [['Name', 'Qty'], ['a', 1], ['b', 2], ['a', 3]].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
}

it('clears and reapplies an advanced filter after the file is opened again', async () => {
  const back = await reopened((wb) => {
    const id = wb.activeSheetId;
    list(wb, id);
    wb.setInput(id, 0, 5, 'Name');
    wb.setInput(id, 1, 5, 'a');
    advancedFilter(wb, id, { list: { r1: 0, c1: 0, r2: 3, c2: 1 }, criteria: { range: { r1: 0, c1: 5, r2: 1, c2: 5 } } });
  });
  const id = back.activeSheetId;
  expect([...back.sheet(id).hiddenRows]).toEqual([2]);
  expect(sheetHasFiltering(back, id)).toBe(true);
  back.setInput(id, 1, 5, 'b');
  reapplySheetFilters(back, id);
  expect([...back.sheet(id).hiddenRows].sort()).toEqual([1, 3]);
  expect(clearSheetFilters(back, id)).toBe(true);
  expect([...back.sheet(id).hiddenRows]).toEqual([]);
});

it('keeps criteria on another sheet tied to that sheet', async () => {
  const back = await reopened((wb) => {
    const id = wb.activeSheetId;
    list(wb, id);
    const other = wb.addSheet('Criteria');
    wb.setInput(other.id, 0, 0, 'Qty');
    wb.setInput(other.id, 1, 0, '>1');
    advancedFilter(wb, id, { list: { r1: 0, c1: 0, r2: 3, c2: 1 }, criteria: { sheetId: other.id, range: { r1: 0, c1: 0, r2: 1, c2: 0 } } });
  });
  const data = back.sheets[0].id, other = back.sheetByName('Criteria').id;
  expect(back.sheet(data).advancedFilter.criteria.sheetId).toBe(other);
  back.setInput(other, 1, 0, '>2');
  reapplySheetFilters(back, data);
  expect([...back.sheet(data).hiddenRows].sort()).toEqual([1, 2]);
});
