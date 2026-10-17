// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

const grids = [];
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: t => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function ({ left, top }) { this.scrollLeft = left; this.scrollTop = top; };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
});
afterEach(() => { for (const grid of grids.splice(0)) grid.destroy(); document.body.replaceChildren(); });

function mount(cols = 200) {
  const wb = new Workbook({ sheets: [{ name: 'Data', rows: 1000, cols }] });
  const grid = createGrid({ wb, sheetId: wb.activeSheetId, announce() {} });
  grids.push(grid);
  document.body.append(grid.el);
  const viewport = grid.viewport;
  const key = (k, init = {}) => viewport.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  // Where the active cell sits on screen.
  const top = () => Math.round(grid.cellRect(grid.active.r, grid.active.c).top);
  const left = () => Math.round(grid.cellRect(grid.active.r, grid.active.c).left);
  return { wb, grid, viewport, key, top, left };
}

// PageDown and PageUp scroll the sheet by a page and keep the active cell where it was on screen, as in
// Excel; they moved the cell a page and scrolled only enough to bring it back into view, at the bottom edge.
it('scrolls a whole page with PageDown and PageUp, keeping the active cell in place on screen', () => {
  const { grid, viewport, key, top } = mount();
  grid.selectByName('B4');
  const screen = top();
  key('PageDown');
  const r1 = grid.active.r;
  expect(r1).toBeGreaterThan(10);
  expect(viewport.scrollTop).toBeGreaterThan(0);
  expect(top()).toBe(screen);
  key('PageDown');
  const r2 = grid.active.r;
  expect(r2 - r1).toBe(r1 - 3);
  expect(top()).toBe(screen);
  key('PageUp');
  expect(grid.active).toEqual({ r: r1, c: 1 });
  expect(top()).toBe(screen);
  key('PageUp');
  key('PageUp');
  expect(grid.active).toEqual({ r: 0, c: 1 });
  expect(viewport.scrollTop).toBe(0);
});

it('pages right and left with Alt+PageDown and Alt+PageUp', () => {
  const { grid, viewport, key, left } = mount();
  grid.selectByName('B4');
  const screen = left();
  key('PageDown', { altKey: true });
  const c1 = grid.active.c;
  expect(grid.active.r).toBe(3);
  expect(c1).toBeGreaterThan(3);
  expect(viewport.scrollTop).toBe(0);
  expect(left()).toBe(screen);
  key('PageUp', { altKey: true });
  expect(grid.active).toEqual({ r: 3, c: 1 });
  expect(viewport.scrollLeft).toBe(0);
  // Shift extends the selection by the page.
  key('PageDown', { altKey: true, shiftKey: true });
  expect(grid.range).toEqual({ r1: 3, c1: 1, r2: 3, c2: c1 });
});

it('reaches the blank columns a page shows past the sheet\'s laid-out end', () => {
  const { wb, grid, viewport, key, left } = mount(16);
  const width = wb.colWidth(wb.activeSheetId, 0);
  grid.selectByName('B4');
  const screen = left();
  key('PageDown', { altKey: true });
  key('PageDown', { altKey: true });
  // The sheet reaches as far as the view a second page to the right shows, so the page scrolls in full.
  expect(wb.activeSheet.cols).toBeGreaterThan(16);
  expect(wb.activeSheet.cols * width).toBeGreaterThanOrEqual(viewport.scrollLeft + viewport.clientWidth);
  expect(left()).toBe(screen);
});
