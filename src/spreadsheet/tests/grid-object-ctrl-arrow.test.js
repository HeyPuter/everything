// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// Ctrl/Cmd+arrow with a text box (or chart) selected took the cells behind it to the edge of their data, as far
// as XFD1, scrolling the sheet away from the object, which stayed selected. It nudges the object one pixel now,
// as in Excel, and Ctrl+Shift+arrow does nothing.
beforeEach(() => {
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
const key = (grid, k, extra) => grid.viewport.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ctrlKey: true, metaKey: true, ...extra }));

it('nudges the selected object a pixel with Ctrl+arrow and leaves the cells where they are', async () => {
  const wb = new Workbook(), id = wb.sheets[0].id;
  const a = wb.addChart(id, { type: 'text', text: 'One', anchor: { r: 2, c: 1 }, dx: 4, dy: 4, w: 120, h: 60 });
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  grid.selectChart(a);
  const cell = grid.active, at = wb.objectRect(id, a);
  key(grid, 'ArrowRight'); key(grid, 'ArrowDown'); key(grid, 'ArrowDown');
  await flush();
  expect(wb.objectRect(id, a).x - at.x).toBeCloseTo(1, 5);
  expect(wb.objectRect(id, a).y - at.y).toBeCloseTo(2, 5);
  key(grid, 'ArrowRight', { shiftKey: true });
  await flush();
  expect(wb.objectRect(id, a).x - at.x).toBeCloseTo(1, 5);
  expect(grid.active).toEqual(cell);
  expect(grid.selectedChart).toBe(a);
  grid.destroy();
});
