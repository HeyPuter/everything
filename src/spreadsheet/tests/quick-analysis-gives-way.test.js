// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createQuickAnalysis } from '../src/ui/quick-analysis.js';
import { createOptionButton } from '../src/ui/option-button.js';

// After a fill-handle drag (or a paste) the Auto Fill Options (Paste Options) button appears at the
// corner of the filled block, and the filled block is still selected, so the Quick Analysis button was
// drawn at that same corner on top of it, hiding its icon. As in Excel, the options button is the one
// shown; Quick Analysis comes back once it goes.

const VP = { left: 100, top: 200, right: 900, bottom: 700, width: 800, height: 500 };

describe('Quick Analysis and the options button', () => {
  it('Quick Analysis gives way while the options button shows at the corner', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    for (let r = 0; r < 7; r++) wb.setInput(id, r, 0, String(r + 1));
    const range = { r1: 0, c1: 0, r2: 6, c2: 0 };
    const viewport = Object.assign(document.createElement('div'), { getBoundingClientRect: () => VP });
    const host = Object.assign(document.createElement('div'), { getBoundingClientRect: () => VP });
    const grid = {
      el: host, viewport, editing: false, sheetId: id, range, ranges: [range], frozen: { rows: 0, cols: 0 }, focus() {},
      cellRect: (r, c) => ({ left: VP.left + c * 100, top: VP.top + r * 20, right: VP.left + c * 100 + 100, bottom: VP.top + r * 20 + 20, width: 100, height: 20 }),
    };
    const ctx = { wb, grid, run: vi.fn(), subscribe: () => () => {} };
    const optionButton = ctx.optionButton = createOptionButton({ grid, host, onToggle: () => ctx.quickAnalysis?.place() });
    const qa = ctx.quickAnalysis = createQuickAnalysis({ ...ctx });
    qa.place();
    expect(qa.el.hidden).toBe(false);
    optionButton.show({ kind: 'fill', sheetId: id, range, mark: 1, items: [{ key: 'series', label: 'Fill Series' }], checked: 'series', onPick() {} });
    expect(optionButton.visible).toBe(true);
    expect(qa.el.hidden).toBe(true);
    qa.place(); // a scroll or a selection change meanwhile
    expect(qa.el.hidden).toBe(true);
    optionButton.hide();
    expect(qa.el.hidden).toBe(false);
    qa.destroy();
    optionButton.destroy();
  });
});
