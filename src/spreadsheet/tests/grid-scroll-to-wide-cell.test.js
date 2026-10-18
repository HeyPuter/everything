// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// A cell wider (or taller) than the view was brought in by its far edge: moving right into an 800px
// column on a laptop with the assistant open, or into any wide column zoomed in, scrolled its right edge
// to the view's, so only the end of its text showed and its start, where typing goes, was out of sight.
// Such a cell now comes in by its top-left corner, as in Excel.
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

function mount(setup) {
  const wb = new Workbook({ sheets: [{ name: 'Data', rows: 100, cols: 20 }] });
  const id = wb.activeSheetId;
  setup?.(wb, id);
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  grids.push(grid);
  document.body.append(grid.el);
  const key = (k, init = {}) => grid.viewport.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  // Where a cell is in the view: 0 is the view's left (top) edge.
  const at = (r, c) => { const rect = grid.cellRect(r, c), vp = grid.viewport.getBoundingClientRect(); return { left: rect.left - vp.left, top: rect.top - vp.top, right: rect.right - vp.left }; };
  return { wb, id, grid, key, at };
}

it('brings a column wider than the view in by its left edge', () => {
  const { grid, key, at } = mount((wb, id) => wb.setColWidth(id, 1, 800));
  grid.setZoom(2); // B is 1600px wide in an 800px view
  grid.selectByName('A1');
  key('ArrowRight');
  expect(grid.active).toEqual({ r: 0, c: 1 });
  expect(at(0, 1).left).toBe(0);
  // A column that fits is still brought in by its right edge, scrolling no further than it must.
  key('ArrowRight');
  expect(at(0, 2).right).toBe(800);
});

it('brings a row taller than the view in by its top', () => {
  const { grid, key, at } = mount((wb, id) => wb.setRowHeight(id, 5, 400));
  grid.setZoom(2); // row 6 is 800px tall in a 400px view
  grid.selectByName('A5');
  key('ArrowDown');
  expect(grid.active).toEqual({ r: 5, c: 0 });
  expect(at(5, 0).top).toBe(0);
});

it('keeps a wide column clear of the frozen columns', () => {
  const { grid, key, at } = mount((wb, id) => { wb.setColWidth(id, 2, 800); wb.setFrozen(id, 0, 1); });
  grid.setZoom(2);
  grid.selectByName('B1');
  key('ArrowRight');
  expect(grid.active).toEqual({ r: 0, c: 2 });
  // Column A, 200px at 200%, stays frozen at the left; C starts just after it.
  expect(at(0, 2).left).toBe(200);
});
