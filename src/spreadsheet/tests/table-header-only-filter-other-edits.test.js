import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

const grid = (rows) => rows.flatMap((row, r) => row.map((v, c) => ({ r, c, cell: v == null ? null : { v } })));

/** A table whose data rows were all deleted: only its header row is left, with its filter buttons. */
function headerOnly() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, grid([['Name', 'Amt'], ['x', 5], ['y', 7], [null, null], [null, null], ['a', 'b'], ['c', 'd']]));
  wb.setCells(id, [{ r: 0, c: 10, cell: { v: 'far' } }]);
  const tid = wb.addTable(id, { r1: 0, c1: 0, r2: 2, c2: 1 }, { name: 'T' });
  wb.deleteRows(id, 1, 2);
  expect(wb.tableById(id, tid).range).toEqual({ r1: 0, c1: 0, r2: 0, c2: 1 });
  expect(wb.filterAt(id, 0, 0)).not.toBeNull();
  return { wb, id, tid };
}

it('keeps the filter buttons of a header-only table when a column elsewhere is deleted', () => {
  const { wb, id, tid } = headerOnly();
  wb.deleteCols(id, 10, 1);
  expect(wb.sheet(id).filter).toEqual({ range: { r1: 0, c1: 0, r2: 0, c2: 1 }, criteria: {} });
  // The buttons come back over the rows the table grows by, as they do when no column was deleted.
  wb.addTableRow(id, tid);
  expect(wb.filterAt(id, 1, 0)?.range).toEqual({ r1: 0, c1: 0, r2: 1, c2: 1 });
});

it('keeps them when a column to the left moves the table', () => {
  const { wb, id } = headerOnly();
  wb.insertCols(id, 0, 1);
  wb.deleteCols(id, 0, 1);
  expect(wb.sheet(id).filter).toEqual({ range: { r1: 0, c1: 0, r2: 0, c2: 1 }, criteria: {} });
  wb.undo();
  expect(wb.sheet(id).filter).toEqual({ range: { r1: 0, c1: 1, r2: 0, c2: 2 }, criteria: {} });
});

it('keeps them when cells below or beside the header are deleted', () => {
  const up = headerOnly();
  expect(up.wb.deleteCells(up.id, { r1: 3, c1: 0, r2: 3, c2: 1 }, 'up')).toBe(true);
  expect(up.wb.sheet(up.id).filter?.range).toEqual({ r1: 0, c1: 0, r2: 0, c2: 1 });
  const left = headerOnly();
  expect(left.wb.deleteCells(left.id, { r1: 0, c1: 5, r2: 0, c2: 5 }, 'left')).toBe(true);
  expect(left.wb.sheet(left.id).filter?.range).toEqual({ r1: 0, c1: 0, r2: 0, c2: 1 });
});

it('still drops a plain filter when a deletion leaves it only its header row', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, grid([['Name', 'Amt'], ['x', 5], ['y', 7]]));
  wb.setFilterRange(id, { r1: 0, c1: 0, r2: 2, c2: 1 });
  expect(wb.deleteCells(id, { r1: 1, c1: 0, r2: 2, c2: 1 }, 'up')).toBe(true);
  expect(wb.sheet(id).filter).toBeNull();
});
