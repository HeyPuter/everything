// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// The headings' letters and numbers grow with the zoom (chrome.css draws them at 12px × zoom), but the
// headings themselves kept their 100% size: at 400% the column letters were cut in half by the 20px
// heading and a row number such as 24 showed only its last digit. Above 100% the headings now grow with
// the zoom, as Excel's do; zoomed out they keep their size so they can still be pressed.
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

function mount() {
  const wb = new Workbook({ sheets: [{ name: 'Data', rows: 100, cols: 20 }] });
  const grid = createGrid({ wb, sheetId: wb.activeSheetId, announce() {} });
  grids.push(grid);
  document.body.append(grid.el);
  const size = () => ({ w: parseFloat(grid.el.style.getPropertyValue('--row-header-w')), h: parseFloat(grid.el.style.getPropertyValue('--col-header-h')) });
  return { grid, size };
}

it('grows the headings with the zoom above 100%, so their labels fit', () => {
  const { grid, size } = mount();
  const base = size();
  expect(base.w).toBeGreaterThan(0);
  expect(base.h).toBeGreaterThan(0);
  grid.setZoom(4);
  expect(size()).toEqual({ w: base.w * 4, h: base.h * 4 });
  grid.setZoom(2);
  expect(size()).toEqual({ w: base.w * 2, h: base.h * 2 });
  grid.setZoom(1);
  expect(size()).toEqual(base);
});

it('keeps the headings their size zoomed out, so they can still be pressed', () => {
  const { grid, size } = mount();
  const base = size();
  grid.setZoom(0.1);
  expect(size()).toEqual(base);
});
