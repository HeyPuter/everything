// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { insertTableSlicers, insertPivotSlicers } from '../src/core/slicer-insert.js';
import { pivotBook } from './helpers/native-pivot-report-fixture.js';

function salesBook() {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Region', 'Rep', 'Amount', 'Year'], ['East', 'Ann', '4', '2024'], ['West', 'Bob', '9', '2025']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  return { wb, id, tableId: wb.addTable(id, { r1: 0, c1: 0, r2: 2, c2: 3 }, { name: 'Sales' }) };
}
/** Each control's top-left corner in sheet pixels, and whether its offsets stay inside its anchor cell. */
function corners(wb, id) {
  const along = (size, n) => { let s = 0; for (let k = 0; k < n; k++) s += size(k); return s; };
  return wb.sheet(id).charts.map(c => ({
    x: along(k => wb.colWidth(id, k), c.anchor.c) + c.dx, y: along(k => wb.rowHeight(id, k), c.anchor.r) + c.dy,
    inside: c.dx >= 0 && c.dx < wb.colWidth(id, c.anchor.c) && c.dy >= 0 && c.dy < wb.rowHeight(id, c.anchor.r) }));
}

it('anchors each table slicer inserted together to the cell its own corner lies in, cascading as before', () => {
  const { wb, id, tableId } = salesBook();
  insertTableSlicers(wb, id, tableId, ['Region', 'Rep', 'Amount', 'Year']);
  const at = corners(wb, id), x0 = at[0].x, y0 = at[0].y;
  expect(at.map(p => [p.x - x0, p.y - y0])).toEqual([[0, 0], [24, 24], [48, 48], [72, 72]]);
  expect(at.every(p => p.inside)).toBe(true);
  // The third slicer lies over row 3: a row inserted above it moves it down with that row.
  const third = wb.sheet(id).charts[2].id, before = corners(wb, id)[2].y;
  wb.insertRows(id, 2, 1);
  expect(corners(wb, id).find((_, i) => wb.sheet(id).charts[i].id === third).y).toBe(before + wb.rowHeight(id, 2));
});

it('cascades slicers inserted later on from every slicer of the earlier cascade, not over its last one', () => {
  const { wb, id, tableId } = salesBook();
  insertTableSlicers(wb, id, tableId, ['Region', 'Rep']);
  insertTableSlicers(wb, id, tableId, ['Amount', 'Year']);
  const at = corners(wb, id), x0 = at[0].x, y0 = at[0].y;
  expect(at.map(p => [p.x - x0, p.y - y0])).toEqual([[0, 0], [24, 24], [48, 48], [72, 72]]);
  expect(at.every(p => p.inside)).toBe(true);
});

it('anchors each PivotTable slicer inserted together to its own cell', () => {
  const { wb, report } = pivotBook({ dateField: true });
  insertPivotSlicers(wb, report.id, wb.nativePivots.tables[0], [0, 1]);
  const at = corners(wb, report.id);
  expect(at).toHaveLength(2);
  expect([at[1].x - at[0].x, at[1].y - at[0].y]).toEqual([24, 24]);
  expect(at.every(p => p.inside)).toBe(true);
});
