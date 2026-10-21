// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => document.body.replaceChildren());

const flush = () => new Promise((r) => setTimeout(r, 5));

// To tell whether a chart's picture was stale, the grid listed every value spilled anywhere on the sheet, so a
// chart on a sheet beside an array formula entered over the rest of the sheet (seventeen billion results) ran the
// tab out of memory as soon as it was drawn. It reads only what spills into the chart's own range.
it('draws a chart on a sheet holding an array over the rest of the sheet, and redraws it after an edit', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  for (const [r, c, v] of [[0, 0, 'a'], [0, 1, '1'], [1, 0, 'b'], [1, 1, '2']]) wb.setInput(id, r, c, v);
  expect(wb.setArrayFormula(id, { r1: 0, c1: 3, r2: 1048575, c2: 16383 }, '=B1*2')).toBe(true);
  wb.addChart(id, { type: 'column', range: { r1: 0, c1: 0, r2: 1, c2: 1 }, anchor: { r: 3, c: 0 }, w: 300, h: 200 });
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  await flush();
  const box = grid.el.querySelector('.chart-box');
  const drawn = box.querySelector('svg');
  expect(drawn).not.toBeNull();
  wb.setInput(id, 1, 1, '7');
  await flush();
  expect(box.querySelector('svg')).not.toBe(drawn);
  expect(box.textContent).toContain('7');
  grid.destroy();
});
