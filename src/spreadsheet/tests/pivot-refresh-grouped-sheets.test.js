// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { buildPivot, refreshPivot } from '../src/core/pivot.js';
import { insertPivotSheet } from '../src/ui/pivotdialog.js';

// Refresh writes a pivot table built here again over its source. With its sheet grouped with another (both tabs
// selected, then Data > Refresh All or Alt+F5), the cells the refresh rewrote were written over the same cells of the
// other sheet too, as typing into a group is: a new region's row landed in the middle of the other sheet's data.
it('rewrites the pivot table on its own sheet only, whatever sheets are grouped with it', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Region', 'Units'], ['East', '5'], ['West', '3']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  insertPivotSheet(wb, id, buildPivot(wb, id, { range: { r1: 0, c1: 0, r2: 2, c2: 1 }, rowField: 0, colField: null, valueField: 1, agg: 'sum', filters: [] }));
  const pivot = wb.sheets.at(-1);
  const notes = wb.addSheet('Notes');
  wb.setInput(notes.id, 0, 0, 'Mine'); wb.setInput(notes.id, 1, 1, '42');
  wb.insertRows(id, 2, 1); wb.setInput(id, 2, 0, 'North'); wb.setInput(id, 2, 1, '7');
  wb.setActiveSheet(pivot.id);
  wb.groupSheets([pivot.id, notes.id]);
  const grid = (sheetId) => Array.from({ length: 5 }, (_, r) => [0, 1].map((c) => wb.getValue(sheetId, r, c)));
  const before = grid(notes.id);
  expect(refreshPivot(wb, pivot.id)).toEqual({ rows: 3 });
  expect(grid(pivot.id)).toEqual([['Region', 'Sum of Units'], ['East', 5], ['North', 7], ['West', 3], ['Total', 15]]);
  expect(grid(notes.id)).toEqual(before);
  wb.undo();
  expect(grid(pivot.id)[2]).toEqual(['West', 3]);
  expect(grid(notes.id)).toEqual(before);
});
