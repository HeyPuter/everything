// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createQuickAnalysis } from '../src/ui/quick-analysis.js';

// The Quick Analysis button asks whether the selected block holds data. It asked on every scroll event
// and looked through every stored cell of the sheet each time, a few milliseconds a frame while
// scrolling a large sheet with a block selected; now a small block is looked up cell by cell, and the
// answer is kept until the selection or the workbook changes.

const VP = { left: 100, top: 200, right: 900, bottom: 700, width: 800, height: 500 };

describe('Quick Analysis button', () => {
  it('does not look through the sheet again while only the scroll changes', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) wb.setInput(id, r, c, String(r + c));
    for (let r = 10; r < 2000; r++) wb.setInput(id, r, 5, '1');
    const range = { r1: 2, c1: 1, r2: 3, c2: 2 };
    const grid = {
      editing: false, sheetId: id, range, ranges: [range], frozen: { rows: 0, cols: 0 },
      viewport: Object.assign(document.createElement('div'), { getBoundingClientRect: () => VP }),
      cellRect: (r, c) => ({ left: VP.left + c * 100, top: VP.top + r * 20, right: VP.left + c * 100 + 100, bottom: VP.top + r * 20 + 20, width: 100, height: 20 }),
    };
    const qa = createQuickAnalysis({ wb, grid, run: vi.fn(), subscribe: () => () => {} });
    const spy = vi.spyOn(wb, 'getValue');
    qa.place();
    expect(qa.el.hidden).toBe(false);
    const first = spy.mock.calls.length;
    expect(first).toBeLessThanOrEqual(4); // a 2×2 block is looked up cell by cell
    for (let i = 0; i < 20; i++) qa.place();
    expect(spy.mock.calls.length).toBe(first);
    // An edit is asked about afresh.
    for (let r = 2; r < 4; r++) for (let c = 1; c < 3; c++) wb.setInput(id, r, c, '');
    qa.place();
    expect(qa.el.hidden).toBe(true);
    qa.destroy();
  });
});
