// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { insertTableSlicers, insertPivotSlicers } from '../src/core/slicer-insert.js';
import { insertTimeline } from '../src/core/timeline.js';
import { pivotBook } from './helpers/native-pivot-report-fixture.js';

const offsets = (wb, sheetId) => wb.sheet(sheetId).charts.map((c) => [c.anchor.r, c.anchor.c, c.dx, c.dy]);

it('cascades slicers inserted later from the ones already beside the table instead of covering them', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Region', 'Rep', 'Amount'], ['East', 'Ann', '4'], ['West', 'Bob', '9']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const tableId = wb.addTable(id, { r1: 0, c1: 0, r2: 2, c2: 2 }, { name: 'Sales' });
  insertTableSlicers(wb, id, tableId, ['Region']);
  insertTableSlicers(wb, id, tableId, ['Rep', 'Amount']);
  // 24 pixels apart, each anchored to the cell its corner lies in (rows are 19.5 pixels high).
  expect(offsets(wb, id)).toEqual([[0, 4, 0, 0], [1, 4, 24, 4.5], [2, 4, 48, 9]]);
});

it('places a PivotTable slicer clear of a timeline already beside the report', () => {
  const { wb, report, pivot } = pivotBook({ dateField: true });
  insertTimeline(wb, report.id, pivot, 2);
  insertPivotSlicers(wb, report.id, wb.nativePivots.tables[0], [0]);
  const [timeline, slicer] = wb.sheet(report.id).charts;
  expect(timeline.anchor).toEqual({ r: 2, c: 3 });
  // The slicer takes the cascade's next step, in the cell its corner lies in.
  expect([slicer.anchor, slicer.dx, slicer.dy]).toEqual([{ r: 3, c: 3 }, 24, 4.5]);
});
