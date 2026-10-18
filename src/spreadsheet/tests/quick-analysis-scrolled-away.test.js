// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createQuickAnalysis } from '../src/ui/quick-analysis.js';

// The Quick Analysis button sits at the bottom-right corner of a selected block. Scrolled down past the
// block, the button was held at the top of the window, standing over the formula bar and the ribbon (or,
// with frozen rows, over the frozen cells). Now it goes with the block, as the paste options button does.

const VP = { left: 100, top: 200, right: 900, bottom: 700, width: 800, height: 500 };
function setup({ frozenRows = 0 } = {}) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) wb.setInput(id, r, c, String(r + c));
  if (frozenRows) wb.setFrozen(id, frozenRows, 0);
  const view = { scrollTop: 0 };
  const range = { r1: 2, c1: 1, r2: 3, c2: 2 };
  const grid = {
    editing: false, sheetId: id, range, ranges: [range],
    frozen: { rows: frozenRows, cols: 0 },
    viewport: Object.assign(document.createElement('div'), { getBoundingClientRect: () => VP }),
    // Rows 20px tall, columns 100px wide; frozen rows do not scroll.
    cellRect: (r, c) => {
      const top = VP.top + r * 20 - (r < frozenRows ? 0 : view.scrollTop), left = VP.left + c * 100;
      return { left, top, right: left + 100, bottom: top + 20, width: 100, height: 20 };
    },
  };
  const qa = createQuickAnalysis({ wb, grid, run: vi.fn(), subscribe: () => () => {} });
  return { wb, id, qa, view, button: qa.el };
}

describe('Quick Analysis button', () => {
  it('goes when its block is scrolled up out of the window', () => {
    const { qa, view, button } = setup();
    qa.place();
    expect(button.hidden).toBe(false);
    expect(button.style.top).toBe('282px');
    view.scrollTop = 100; // the block's corner (row 4) ends 20px above the window
    qa.place();
    expect(button.hidden).toBe(true);
    view.scrollTop = 0;
    qa.place();
    expect(button.hidden).toBe(false);
    qa.destroy();
  });

  it('goes when its block is scrolled under frozen rows', () => {
    const { qa, view, button } = setup({ frozenRows: 2 });
    view.scrollTop = 45; // the corner ends at 235, under the frozen rows that end at 240
    qa.place();
    expect(button.hidden).toBe(true);
    view.scrollTop = 30;
    qa.place();
    expect(button.hidden).toBe(false);
    qa.destroy();
  });
});
