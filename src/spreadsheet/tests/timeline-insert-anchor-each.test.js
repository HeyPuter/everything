// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { insertTimeline } from '../src/core/timeline.js';
import { pivotBook } from './helpers/native-pivot-report-fixture.js';

// Timelines inserted together cascade 24 pixels down, but every one was anchored to the first one's cell, the later
// ones by offsets reaching rows past it: the third was anchored two rows above where it stood, so a row inserted above
// it left it in place and the offsets saved in a file ran past their cell. Each is now anchored to the cell its own
// corner lies in, at the same position, as a slicer is.

/** Each control's top-left corner in sheet pixels, and whether its offsets stay inside its anchor cell. */
function corners(wb, id) {
  const along = (size, n) => { let s = 0; for (let k = 0; k < n; k++) s += size(k); return s; };
  return wb.sheet(id).charts.map(c => ({
    id: c.id, x: along(k => wb.colWidth(id, k), c.anchor.c) + c.dx, y: along(k => wb.rowHeight(id, k), c.anchor.r) + c.dy,
    inside: c.dx >= 0 && c.dx < wb.colWidth(id, c.anchor.c) && c.dy >= 0 && c.dy < wb.rowHeight(id, c.anchor.r) }));
}

it('anchors each timeline inserted together to the cell its own corner lies in, cascading as before', () => {
  const { wb, report, pivot } = pivotBook({ dateField: true });
  wb.transaction('Insert timeline', () => { for (let i = 0; i < 3; i++) insertTimeline(wb, report.id, pivot, 2, { at: { r: 20, c: 8 } }); });
  const at = corners(wb, report.id), x0 = at[0].x, y0 = at[0].y;
  expect(at.map(p => [p.x - x0, p.y - y0])).toEqual([[0, 0], [0, 24], [0, 48]]);
  expect(at.every(p => p.inside)).toBe(true);
  // The third timeline lies over a row of its own: a row inserted above that row moves it down with it.
  const third = at[2], row = wb.sheet(report.id).charts[2].anchor.r;
  expect(row).toBeGreaterThan(20);
  expect(wb.insertRows(report.id, row, 1)).not.toBe(false);
  expect(corners(wb, report.id).find(p => p.id === third.id).y).toBe(third.y + wb.rowHeight(report.id, row));
});
