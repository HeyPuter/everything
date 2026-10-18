import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';

// A custom view kept its hidden rows and columns, its filter and its print area as line numbers that nothing
// updated: after a row was inserted above them, showing the view hid the wrong rows (one of the detail rows
// shown, a summary row hidden), filtered the wrong block and printed the wrong area. Excel keeps these as
// names that follow the sheet's edits; the views now follow inserted, deleted and moved lines too, as one
// undo step with the edit.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const rows = [['Kind', 'Qty'], ['x', 1], ['y', 2], ['x', 3], ['y', 4], ['Total', 10]];
  wb.setCells(id, rows.flatMap((row, r) => row.map((v, c) => ({ r, c, cell: { v } }))));
  wb.setFilterRange(id, parseRange('A1:B5'));
  wb.setFilterCriteria(id, 0, { values: ['x'] });
  wb.setHidden(id, 'col', [3], true);
  wb.setPrintSettings(id, { areas: [parseRange('A1:B6')] });
  const view = wb.addCustomView('Only x');
  // Back to everything shown, no filter, no print area.
  wb.clearFilter(id);
  wb.setHidden(id, 'col', [3], false);
  wb.setPrintSettings(id, { areas: [] });
  wb.clearHistory();
  return { wb, id, view };
}
const state = (wb, id) => {
  const s = wb.sheet(id);
  return { hidden: [...s.filterHidden].sort((a, b) => a - b), cols: [...s.hiddenCols], filter: s.filter?.range, areas: s.printSettings?.areas };
};

it('shows the rows, columns and print area it was made with after rows are inserted above them', () => {
  const { wb, id, view } = book();
  wb.insertRows(id, 0, 2);
  wb.insertCols(id, 0, 1);
  wb.showCustomView(view);
  expect(state(wb, id)).toEqual({ hidden: [4, 6], cols: [4], filter: parseRange('B3:C7'), areas: [parseRange('B3:C8')] });
  expect(wb.getValue(id, 4, 1)).toBe('y');
});

it('follows deleted and moved rows, and undo takes the view back with the edit', () => {
  const { wb, id, view } = book();
  const before = JSON.stringify(wb.customViews);
  wb.deleteRows(id, 2, 1); // the first y
  wb.moveRows(id, 4, 1, 0); // Total to the top
  wb.showCustomView(view);
  expect(state(wb, id)).toEqual({ hidden: [4], cols: [3], filter: parseRange('A2:B5'), areas: [parseRange('A1:B5')] });
  expect(wb.getValue(id, 4, 0)).toBe('y');
  wb.undo(); wb.undo(); wb.undo();
  expect(JSON.stringify(wb.customViews)).toBe(before);
  wb.redo(); wb.redo();
  expect(wb.customViews[0].sheets[id].filter.range).toEqual(parseRange('A2:B5'));
});
