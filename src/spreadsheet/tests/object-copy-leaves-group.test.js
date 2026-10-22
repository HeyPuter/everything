import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { withGroups } from '../src/core/arrange.js';
import { moveChart } from '../src/ui/chart-actions.js';

// Duplicating an object of a group put the copy in that group, at the front of the sheet's objects, away from
// the rest of the group: a click on the original then selected the copy as well and dragged it along, and the
// group no longer lay together in the stacking order. A chart moved to another sheet took its group's id there
// too, a group of one. A copy, and a chart moved away, now stand on their own.
function sheetWithGroup() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: 'x' } }, { r: 0, c: 1, cell: { v: 1 } }]);
  const a = wb.addChart(id, { type: 'column', range: { r1: 0, c1: 0, r2: 0, c2: 1 }, anchor: { r: 2, c: 0 }, w: 200, h: 150 });
  const b = wb.addChart(id, { type: 'text', text: 'Note', anchor: { r: 2, c: 5 }, w: 100, h: 50 });
  const c = wb.addChart(id, { type: 'text', text: 'Other', anchor: { r: 12, c: 5 }, w: 100, h: 50 });
  wb.groupObjects(id, [a, b]);
  return { wb, id, a, b, c };
}

it('leaves the copy of a grouped object out of the group', () => {
  const { wb, id, a, b } = sheetWithGroup();
  const copy = wb.duplicateChart(id, a);
  expect(wb.chartById(id, copy).group).toBeUndefined();
  expect(withGroups(wb.sheet(id).charts, [a]).sort()).toEqual([a, b].sort());
  expect(withGroups(wb.sheet(id).charts, [copy])).toEqual([copy]);
});

it('takes a chart moved to another sheet out of its group', () => {
  const { wb, id, a } = sheetWithGroup();
  const other = wb.addSheet('Other').id;
  wb.setActiveSheet(id);
  const moved = moveChart({ wb, sheetId: () => id }, wb.chartById(id, a), { toSheetId: other });
  expect(moved).toBeTruthy();
  expect(wb.chartById(other, moved).group).toBeUndefined();
});
