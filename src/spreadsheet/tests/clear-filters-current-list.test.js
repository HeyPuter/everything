import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { clearSheetFilters } from '../src/core/advanced-filter.js';

// Data ▸ Clear cleared every filter on the sheet: with two filtered tables, Clear given from a cell of one also
// showed all the rows of the other. Excel clears the filter of the current range; from a cell outside every list,
// the app still clears them all.
function twoTables() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Region', 'V'], ['East', '1'], ['West', '2'], ['East', '3']].forEach((row, r) => row.forEach((v, c) => {
    wb.setInput(id, r, c, v);
    wb.setInput(id, r + 6, c + 4, v);
  }));
  wb.addTable(id, { r1: 0, c1: 0, r2: 3, c2: 1 });
  wb.addTable(id, { r1: 6, c1: 4, r2: 9, c2: 5 });
  const left = wb.filterAt(id, 0, 0), right = wb.filterAt(id, 6, 4);
  wb.setFilterCriteria(id, 0, { values: ['East'] }, left);
  wb.setFilterCriteria(id, 4, { values: ['West'] }, right);
  return { wb, id, criteria: () => [[0, 0], [6, 4]].map(([r, c]) => Object.keys(wb.filterAt(id, r, c).criteria).length) };
}

it('clears only the list at the cell it is given from', () => {
  const { wb, id, criteria } = twoTables();
  expect(criteria()).toEqual([1, 1]);
  expect(clearSheetFilters(wb, id, { r: 8, c: 5 })).toBe(true);
  expect(criteria()).toEqual([1, 0]);
  expect([...wb.sheet(id).filterHidden].sort()).toEqual([2]); // the left table's West row stays hidden
  expect(clearSheetFilters(wb, id, { r: 8, c: 5 })).toBe(false); // nothing left to clear in that one
  expect(criteria()).toEqual([1, 0]);
});

it('clears every list from a cell outside them', () => {
  const { wb, id, criteria } = twoTables();
  expect(clearSheetFilters(wb, id, { r: 10, c: 10 })).toBe(true);
  expect(criteria()).toEqual([0, 0]);
  wb.undo();
  expect(criteria()).toEqual([1, 1]);
});
