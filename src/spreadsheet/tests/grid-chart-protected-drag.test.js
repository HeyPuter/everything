// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';
import { stylesheet, declared } from './helpers/css.js';

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
const pe = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 4, button: 0, pointerType: 'mouse' }));

// On a protected sheet a chart (picture, shape) followed the pointer across the sheet as it was dragged, then
// jumped back where it was when let go, and its resize corner was offered. It now stays put under a drag, which
// says once that the sheet is protected, and no corner is shown; it can still be selected.
it('keeps a chart still under a drag on a protected sheet, and says why once', async () => {
  const wb = new Workbook(), id = wb.sheets[0].id;
  wb.setInput(id, 0, 0, '1');
  const chartId = wb.addChart(id, { type: 'column', range: { r1: 0, c1: 0, r2: 0, c2: 0 }, anchor: { r: 1, c: 2 }, dx: 10, dy: 5, w: 300, h: 200 });
  wb.setSheetProtected(id, true);
  let told = 0;
  wb.addEventListener('change', ({ detail }) => { if (detail?.type === 'protected') told++; });
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  const box = grid.el.querySelector('.chart-box');
  const before = box.style.transform;
  pe(box, 'pointerdown', 300, 60);
  pe(box, 'pointermove', 360, 90);
  pe(box, 'pointermove', 420, 120);
  await flush();
  expect(box.style.transform).toBe(before);
  expect(told).toBe(1);
  pe(box, 'pointerup', 420, 120);
  await flush();
  expect(grid.selectedChart).toBe(chartId);
  expect(box.style.transform).toBe(before);
  expect(wb.chartById(id, chartId)).toMatchObject({ dx: 10, dy: 5 });
  expect(grid.el.classList.contains('protected')).toBe(true);
  expect(declared(stylesheet('grid.css'), '.grid.protected .chart-box.selected .chart-resize', false).display).toBe('none');
  grid.destroy();
});
