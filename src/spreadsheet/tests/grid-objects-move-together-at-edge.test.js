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
afterEach(() => { document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));

// With several objects selected, the one pressed stopped at the sheet's edge but the others went on by the
// same distance and were then pushed back to the edge on their own, so a drag or an arrow key past the
// edge closed the gaps between them and broke up an arrangement. They now stop together.
async function setup() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const a = wb.addChart(id, { type: 'column', range: { r1: 0, c1: 0, r2: 1, c2: 1 }, anchor: { r: 2, c: 0 }, dx: 20, dy: 4, w: 200, h: 120 });
  const b = wb.addChart(id, { type: 'column', range: { r1: 0, c1: 0, r2: 1, c2: 1 }, anchor: { r: 8, c: 3 }, dx: 0, dy: 0, w: 200, h: 120 });
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  await flush();
  grid.selectCharts([a, b]);
  await flush();
  return { wb, id, a, b, grid };
}

it('keeps the gap between objects dragged together past the sheet edge', async () => {
  const { wb, id, a, b, grid } = await setup();
  const gap = () => { const ra = wb.objectRect(id, a), rb = wb.objectRect(id, b); return [rb.x - ra.x, rb.y - ra.y]; };
  const before = gap();
  const box = grid.el.querySelector(`.chart-box[data-chart="${b}"]`);
  for (const [type, x, y] of [['pointerdown', 400, 250], ['pointermove', -600, -600], ['pointerup', -600, -600]]) {
    box.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 3, button: 0, pointerType: 'mouse' }));
  }
  await flush();
  // Within a pixel: rows are drawn at whole pixels on screen, a little off their exact heights.
  const after = gap();
  expect(Math.abs(after[0] - before[0])).toBeLessThanOrEqual(1);
  expect(Math.abs(after[1] - before[1])).toBeLessThanOrEqual(1);
  expect(wb.objectRect(id, a)).toMatchObject({ x: 0, y: 0 });
  grid.destroy();
});

it('keeps the gap between objects nudged with the arrow keys against the sheet edge', async () => {
  const { wb, id, a, b, grid } = await setup();
  const viewport = grid.el.querySelector('.grid-viewport');
  const key = (k) => viewport.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const xb = wb.objectRect(id, b).x;
  for (let i = 0; i < 5; i++) key('ArrowLeft');
  await flush();
  expect(wb.objectRect(id, a).x).toBe(0);
  expect(wb.objectRect(id, b).x).toBe(xb - 20);
  grid.destroy();
});
