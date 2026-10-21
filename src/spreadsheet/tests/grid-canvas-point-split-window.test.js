// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';
import * as S from '../src/core/selection.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollBy = function scrollBy() {};
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

// Ink is drawn at the canvas point under the pen (canvasPoint) and anchored to the cell there (placeAt).
// In a split window the scrolling pane's canvas sits in by the split, which canvasPoint left out: a stroke
// drawn over a cell landed the split's width to the right and its height below it.
it('gives the canvas point of the cell under the pen in a split window', () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  const viewport = grid.el.querySelector('.grid-viewport');
  viewport.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 });
  const scroll = { left: 0, top: 0 };
  Object.defineProperty(viewport, 'scrollLeft', { configurable: true, get: () => scroll.left, set: (v) => { scroll.left = v; } });
  Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => scroll.top, set: (v) => { scroll.top = v; } });
  viewport.scrollTo = ({ left, top }) => { scroll.left = Math.max(0, left); scroll.top = Math.max(0, top); viewport.dispatchEvent(new Event('scroll')); };
  vi.runOnlyPendingTimers();
  grid.setSelection(S.single(9, 4)); // E10: the split goes above and left of it
  vi.runOnlyPendingTimers();
  grid.toggleSplit();
  vi.runOnlyPendingTimers();
  expect(grid.split).toBeTruthy();
  for (const [x, y] of [[500, 300], [700, 380]]) {
    const p = grid.canvasPoint(x, y);
    expect(grid.placeAt(p.x, p.y).anchor).toEqual(grid.cellAtPoint(x, y));
  }
  grid.destroy();
});
