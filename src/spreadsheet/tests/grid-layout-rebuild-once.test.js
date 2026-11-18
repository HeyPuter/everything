// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook, DEFAULT_ROW_HEIGHT } from '../src/core/workbook.js';
import * as S from '../src/core/selection.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

const ROW = Math.round(DEFAULT_ROW_HEIGHT); // a default row on screen at 100%

const flush = () => new Promise((r) => setTimeout(r, 5));

/** A 2,100-row sheet, and a count of the grid's offset rebuilds (each one restates the viewport's aria-rowcount). */
async function mount() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.ensureSize(id, 2100, 26);
  wb.setInput(id, 0, 0, 'top');
  wb.setInput(id, 2099, 0, 'bottom'); // keeps the sheet 2,100 rows long: an empty end is given back once it is shown
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  let rebuilds = 0;
  const original = Element.prototype.setAttribute;
  vi.spyOn(Element.prototype, 'setAttribute').mockImplementation(function patched(name, value) {
    if (this === grid.viewport && name === 'aria-rowcount') rebuilds++;
    return original.call(this, name, value);
  });
  return { wb, id, grid, rebuilds: () => rebuilds };
}

// Every layout event rebuilt the offsets of every row and column at once, so a transaction that
// resized 2,000 rows laid the sheet out 2,000 times before anything was drawn.
describe('the row and column offsets after layout changes', () => {
  it('are rebuilt once for a burst of two thousand row resizes, in the frame that follows', { timeout: 60000 }, async () => {
    const { wb, id, grid, rebuilds } = await mount();
    wb.transaction('Resize rows', () => { for (let r = 0; r < 2000; r++) wb.setRowHeight(id, r, 30); });
    expect(rebuilds()).toBeLessThanOrEqual(1);
    await flush();
    expect(rebuilds()).toBe(1);
    expect(grid.el.querySelector('.grid-canvas').style.height).toBe(`${2000 * 30 + 100 * ROW}px`);
    grid.destroy();
  });

  it('are still right for a read that follows a change at once, before any frame has run', async () => {
    const { wb, id, grid, rebuilds } = await mount();
    wb.setRowHeight(id, 0, 60);
    expect(rebuilds()).toBe(0);
    expect(grid.cellRect(1, 0).top).toBe(60); // laid out on the first read
    expect(rebuilds()).toBe(1);
    wb.setColWidth(id, 0, 150);
    grid.setSelection(S.single(0, 1));
    expect(grid.cellRect(0, 1).left).toBe(150);
    wb.setFrozen(id, 2, 0);
    expect(grid.frozen).toEqual({ rows: 2, cols: 0 }); // the effective pane is read fresh too
    await flush();
    expect(rebuilds()).toBeLessThanOrEqual(3); // one per change that was read, none extra for the frame
    grid.destroy();
  });

  it('keep a whole-column selection covering the sheet when a scroll near the edge grows it', async () => {
    const { wb, id, grid } = await mount();
    grid.setSelection(S.selectCols(1, 1, { rows: 2100, cols: 26 }));
    wb.setRowHeight(id, 3, 40); // a layout change not yet laid out
    Object.defineProperty(grid.viewport, 'scrollTop', { configurable: true, get: () => 2100 * ROW - 300, set() {} });
    grid.viewport.dispatchEvent(new Event('scroll'));
    expect(wb.sheet(id).rows).toBe(2200);
    expect(grid.range).toEqual({ r1: 0, c1: 1, r2: 1048575, c2: 1 }); // the whole column, however far the sheet has grown
    grid.destroy();
  });
});
