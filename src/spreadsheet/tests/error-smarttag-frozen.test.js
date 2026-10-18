// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { createErrorSmartTag } from '../src/ui/error-smarttag.js';
import { Workbook, DEFAULT_ROW_HEIGHT } from '../src/core/workbook.js';

// The error-checking smart tag stands beside the active cell. Scrolled under frozen rows, the cell is
// hidden by them, but its tag stayed, drawn over the frozen cells (and, partly under them, over the
// freeze line). It now goes with its cell, and keeps below the frozen rows while the cell shows.

const ROW = Math.round(DEFAULT_ROW_HEIGHT);
let scroll = 0;
beforeEach(() => {
  scroll = 0;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));

describe('the error smart tag and frozen rows', () => {
  it('goes when its cell scrolls under the frozen rows', async () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    wb.setInput(id, 5, 2, '=1/0');
    wb.setFrozen(id, 3, 0);
    const grid = createGrid({ wb, sheetId: id });
    document.body.replaceChildren(grid.el);
    const vp = grid.viewport;
    vp.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 });
    Object.defineProperty(vp, 'scrollTop', { configurable: true, get: () => scroll, set: (v) => { scroll = v; } });
    await flush();
    const tag = createErrorSmartTag({ wb, grid, run() {}, subscribe: () => () => {} });
    grid.setSelection({ active: { r: 5, c: 2 }, anchor: { r: 5, c: 2 }, focus: { r: 5, c: 2 } });
    tag.sync();
    expect(tag.el.hidden).toBe(false);
    expect(parseFloat(tag.el.style.top)).toBe(5 * ROW + 1);
    scroll = 2.5 * ROW; // row 6 half under the frozen rows, which end at 3 rows down
    tag.sync();
    expect(tag.el.hidden).toBe(false);
    expect(parseFloat(tag.el.style.top)).toBe(3 * ROW);
    scroll = 3 * ROW; // row 6 wholly under them
    tag.sync();
    expect(tag.el.hidden).toBe(true);
    tag.destroy();
    grid.destroy();
  });
});
