import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';

// Cutting a whole filtered list and pasting it elsewhere on the sheet moved its cells but left the filter behind:
// the emptied rows it had filtered stayed hidden (with anything else on those rows of the sheet), its buttons sat
// over blank cells, and the list arrived unfiltered. A table's filter already went with its table; a sheet's
// filter whose whole list the block carries now goes with it too, criteria and all, and undo brings it back.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const rows = [['Kind', 'Qty'], ['x', 1], ['y', 2], ['x', 3], ['y', 4], ['x', 5]];
  wb.setCells(id, rows.flatMap((row, r) => row.map((v, c) => ({ r, c, cell: { v } }))));
  wb.setInput(id, 2, 6, 'beside'); // other data on a row the filter hides
  wb.setFilterRange(id, parseRange('A1:B6'));
  wb.setFilterCriteria(id, 0, { values: ['x'] });
  expect([...wb.sheet(id).filterHidden].sort()).toEqual([2, 4]);
  wb.clearHistory();
  return { wb, id };
}

it('carries the filter with the whole list it covers', () => {
  const { wb, id } = book();
  const before = wb.toJSON();
  expect(wb.moveRange(id, parseRange('A1:B6'), 9, 3)).toEqual(parseRange('D10:E15'));
  const sheet = wb.sheet(id);
  expect(sheet.filter.range).toEqual(parseRange('D10:E15'));
  expect(sheet.filter.criteria).toEqual({ 3: { values: ['x'] } });
  // The moved list is filtered where it now is, and the rows it left are shown again.
  expect([...sheet.filterHidden].sort((a, b) => a - b)).toEqual([11, 13]);
  expect(wb.isRowHidden(id, 2)).toBe(false);
  expect(wb.getValue(id, 11, 3)).toBe('y');
  wb.undo();
  expect(wb.toJSON()).toEqual(before);
  expect(wb.isRowHidden(id, 2)).toBe(true);
});

it('leaves the filter where it is when the block takes only part of its list', () => {
  const { wb, id } = book();
  wb.moveRange(id, parseRange('A1:A6'), 0, 8);
  expect(wb.sheet(id).filter.range).toEqual(parseRange('A1:B6'));
});

it('carries it the same way when the cut is pasted (Ctrl+X, Ctrl+V), here or on another sheet', () => {
  let { wb, id } = book();
  const cut = (w, from, range, to, r, c) => w.placeMoved(to, r, c, w.copyRange(from, range), { sheetId: from, range, all: true });
  expect(cut(wb, id, parseRange('A1:B6'), id, 9, 3)).toEqual(parseRange('D10:E15'));
  expect(wb.sheet(id).filter.range).toEqual(parseRange('D10:E15'));
  expect([...wb.sheet(id).filterHidden].sort((a, b) => a - b)).toEqual([11, 13]);
  expect(wb.isRowHidden(id, 2)).toBe(false);
  ({ wb, id } = book());
  const other = wb.addSheet('Other').id;
  expect(cut(wb, id, parseRange('A1:B6'), other, 0, 0)).toEqual(parseRange('A1:B6'));
  expect(wb.sheet(id).filter).toBeNull();
  expect(wb.isRowHidden(id, 2)).toBe(false);
  expect(wb.sheet(other).filter).toMatchObject({ range: parseRange('A1:B6'), criteria: { 0: { values: ['x'] } } });
  expect([...wb.sheet(other).filterHidden].sort()).toEqual([2, 4]);
  wb.undo();
  expect(wb.sheet(id).filter.range).toEqual(parseRange('A1:B6'));
  expect(wb.sheet(other).filter).toBeNull();
  expect(wb.isRowHidden(id, 2)).toBe(true);
});
