// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// Ctrl+Alt+O stepped onto objects hidden with the Selection Pane's eye: nothing showed as selected,
// and the next Delete removed an object nobody could see. Hidden objects are now passed over.
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
const next = (viewport, shiftKey = false) => viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', code: 'KeyO', ctrlKey: true, metaKey: true, altKey: true, shiftKey, bubbles: true, cancelable: true }));

it('steps over hidden objects with Ctrl+Alt+O', async () => {
  const wb = new Workbook(), id = wb.sheets[0].id;
  wb.setInput(id, 0, 0, '1'); wb.setInput(id, 1, 0, '2');
  const first = wb.addChart(id, { type: 'column', range: { r1: 0, c1: 0, r2: 1, c2: 0 }, anchor: { r: 1, c: 2 }, w: 300, h: 200 });
  const hidden = wb.addChart(id, { type: 'text', text: 'Hidden', anchor: { r: 10, c: 1 }, w: 200, h: 60 });
  const third = wb.addChart(id, { type: 'text', text: 'Shown', anchor: { r: 14, c: 1 }, w: 200, h: 60 });
  wb.setObjectsHidden(id, [hidden], true);
  expect(wb.chartById(id, hidden).hidden).toBe(true);
  const grid = createGrid({ wb, sheetId: id, announce: () => {}, onCommand: () => {} });
  document.body.replaceChildren(grid.el);
  await flush();
  next(grid.viewport); expect(grid.selectedChart).toBe(first);
  next(grid.viewport); expect(grid.selectedChart).toBe(third);
  next(grid.viewport); expect(grid.selectedChart).toBe(first);
  next(grid.viewport, true); expect(grid.selectedChart).toBe(third);
  grid.destroy();
});
