// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { moveChart, newChartSheet } from '../src/ui/chart-actions.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

// Moving the only chart of a chart sheet onto a worksheet deletes the emptied chart sheet. Under Protect Workbook
// that deletion is refused, but the chart had already been placed on the worksheet: it ended up on both sheets.
// The move is now refused up front, with the workbook's own "structure is protected" notice.
function book() {
  const wb = new Workbook();
  const data = wb.activeSheetId;
  wb.setInput(data, 0, 0, '1');
  wb.setInput(data, 1, 0, '2');
  const sheet = newChartSheet(wb, { type: 'bar', range: { r1: 0, c1: 0, r2: 1, c2: 0 }, sourceRefs: ['Sheet1!A1:A2'], anchor: { r: 0, c: 0 }, w: 100, h: 100 });
  return { wb, data, sheet, chart: sheet.charts[0] };
}

describe('moving a chart off its chart sheet', () => {
  it('is refused, leaving one chart, while the workbook structure is protected', () => {
    const { wb, data, sheet, chart } = book();
    wb.setStructureProtected(true);
    const notices = [];
    wb.addEventListener('change', (e) => { if (e.detail?.type === 'protected' && e.detail.structure) notices.push(e.detail); });
    const before = wb.toJSON();
    expect(moveChart({ wb, sheetId: () => sheet.id }, chart, { toSheetId: data })).toBe(false);
    expect(wb.sheets.map((s) => s.charts.length)).toEqual([1, 0]);
    expect(wb.toJSON()).toEqual(before);
    expect(notices).toHaveLength(1);
  });

  it('moves it and removes the emptied chart sheet otherwise', () => {
    const { wb, data, sheet, chart } = book();
    expect(moveChart({ wb, sheetId: () => sheet.id }, chart, { toSheetId: data })).toBeTruthy();
    expect(wb.sheets.map((s) => [s.id, s.charts.length])).toEqual([[data, 1]]);
  });
});
