import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';

// A worksheet filter over a table's first rows and columns was taken for the table's own filter when rows were
// inserted: it was stretched down to the table's last data row, the two filters ended up over the same range, and
// one of them was gone (at once when the rows went in above a totals row, or on redo, which loads the step again).
const grid = (rows) => rows.flatMap((row, r) => row.map((v, c) => ({ r, c, cell: { v } })));

function book(totals) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, grid([['N', 'V'], ['a', 1], ['b', 5], ['c', 7], ['d', 2], ['e', 3]]));
  const tid = wb.addTable(id, parseRange('A1:B5'), { name: 'T' });
  if (totals) wb.setTableTotals(id, tid, true);
  wb.setFilterRange(id, parseRange('A1:B3'));
  const ranges = () => wb.filtersForSheet(id).map((f) => f.range).sort((a, b) => a.r2 - b.r2);
  return { wb, id, ranges };
}

it('keeps a worksheet filter its own extent when rows go in inside the table, through undo and redo', () => {
  const { wb, id, ranges } = book(false);
  expect(ranges()).toEqual([parseRange('A1:B3'), parseRange('A1:B5')]);
  wb.insertRows(id, 2, 1);
  const inserted = [parseRange('A1:B4'), parseRange('A1:B6')];
  expect(ranges()).toEqual(inserted);
  wb.undo();
  expect(ranges()).toEqual([parseRange('A1:B3'), parseRange('A1:B5')]);
  wb.redo();
  expect(ranges()).toEqual(inserted);
});

it('keeps both filters when rows go in above the totals row', () => {
  const { wb, id, ranges } = book(true);
  expect(ranges()).toEqual([parseRange('A1:B3'), parseRange('A1:B5')]);
  wb.insertRows(id, 5, 1);
  expect(wb.sheet(id).tables[0].range).toEqual(parseRange('A1:B7'));
  const inserted = [parseRange('A1:B3'), parseRange('A1:B6')];
  expect(ranges()).toEqual(inserted);
  wb.undo();
  wb.redo();
  expect(ranges()).toEqual(inserted);
});
