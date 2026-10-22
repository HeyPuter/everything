// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

let scrolls;
beforeEach(() => {
  scrolls = [];
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo(o) { scrolls.push(o); };
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

// Ctrl+wheel (and a trackpad pinch, which arrives as Ctrl+wheel) zoomed about the sheet's top-left corner,
// so the cell under the pointer slid away; a pinch on a touch screen already kept the spot between the fingers.
it('keeps the spot under the pointer where it is as Ctrl+wheel zooms', () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setColWidth(id, 0, 100);
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  vi.runOnlyPendingTimers();
  const colWidth = wb.colWidth(id, 1);
  // 4.5 columns in from the left edge of the cells, and some rows down.
  const x = 100 + 3.5 * colWidth;
  scrolls.length = 0;
  grid.viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: x, clientY: 200, bubbles: true, cancelable: true }));
  expect(grid.zoom).toBeCloseTo(1.1);
  const last = scrolls.at(-1);
  expect(last).toBeTruthy();
  // The point sits as far into its column as before: half way into E, which now starts further right.
  const startE = Math.round(100 * 1.1) + 3 * Math.round(colWidth * 1.1);
  expect(Math.abs(last.left - (startE + 0.5 * Math.round(colWidth * 1.1) - x))).toBeLessThanOrEqual(1);
  expect(last.top).toBeGreaterThan(0);
});
