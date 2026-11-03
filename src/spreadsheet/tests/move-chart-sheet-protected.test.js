// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { moveChart } from '../src/ui/chart-actions.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

// A protected sheet refuses to give up its chart, but the copy had already been placed on the other sheet (or on a
// new chart sheet): the chart ended up on both. The move is now refused up front, with the sheet's own notice.
function book() {
  const wb = new Workbook();
  const data = wb.activeSheetId;
  wb.setInput(data, 0, 0, '1');
  wb.setInput(data, 1, 0, '2');
  const other = wb.addSheet('Other');
  const id = wb.addChart(data, { type: 'bar', range: { r1: 0, c1: 0, r2: 1, c2: 0 }, sourceRefs: ['Sheet1!A1:A2'], anchor: { r: 3, c: 3 }, w: 200, h: 120 });
  return { wb, data, other: other.id ?? other, chart: wb.chartById(data, id) };
}

describe('moving a chart off a protected sheet', () => {
  for (const [label, where] of [['onto another sheet', (b) => ({ toSheetId: b.other })], ['to a new chart sheet', () => ({ newSheet: 'Chart1' })]]) {
    it(`is refused, leaving the workbook as it was, ${label}`, () => {
      const b = book();
      const { wb, data, chart } = b;
      wb.setSheetProtected(data, true);
      const notices = [];
      wb.addEventListener('change', (e) => { if (e.detail?.type === 'protected') notices.push(e.detail); });
      const before = JSON.stringify(wb.toJSON());
      expect(moveChart({ wb, sheetId: () => data }, chart, where(b))).toBe(false);
      expect(JSON.stringify(wb.toJSON())).toBe(before);
      expect(notices.length).toBeGreaterThan(0);
    });
  }

  it('still moves a chart off an unprotected sheet', () => {
    const b = book();
    expect(moveChart({ wb: b.wb, sheetId: () => b.data }, b.chart, { toSheetId: b.other })).toBeTruthy();
    expect(b.wb.sheet(b.data).charts).toHaveLength(0);
    expect(b.wb.sheet(b.other).charts).toHaveLength(1);
  });
});
