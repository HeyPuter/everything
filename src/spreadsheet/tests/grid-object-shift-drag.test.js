// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// Shift held on an object already selected took it out of the selection on the press, so a Shift-drag (Excel's
// way to move objects straight across or down) never moved anything, and the objects could only be dragged
// freely. The press now leaves the selection be: a Shift-drag moves every object selected along the axis the
// pointer went further on, and a Shift-click without a drag still takes the object out.
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
const pe = (target, type, x, y, shiftKey = false) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, shiftKey }));

async function setup() {
  const wb = new Workbook(), id = wb.sheets[0].id;
  const a = wb.addChart(id, { type: 'text', text: 'One', anchor: { r: 2, c: 1 }, w: 120, h: 60 });
  const b = wb.addChart(id, { type: 'text', text: 'Two', anchor: { r: 2, c: 5 }, w: 120, h: 60 });
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  const box = (o) => grid.el.querySelector(`.chart-box[data-chart="${o}"]`);
  pe(box(a), 'pointerdown', 10, 10); pe(box(a), 'pointerup', 10, 10);
  pe(box(b), 'pointerdown', 10, 10, true); pe(box(b), 'pointerup', 10, 10, true);
  await flush();
  return { wb, id, a, b, grid, box };
}

it('moves the objects selected straight across with Shift held', async () => {
  const { wb, id, a, b, grid, box } = await setup();
  expect(grid.selectedCharts.sort()).toEqual([a, b].sort());
  const before = [wb.objectRect(id, a), wb.objectRect(id, b)];
  pe(box(b), 'pointerdown', 100, 100, true);
  pe(box(b), 'pointermove', 180, 112, true);
  pe(box(b), 'pointerup', 180, 112, true);
  await flush();
  expect(grid.selectedCharts.sort()).toEqual([a, b].sort());
  const after = [wb.objectRect(id, a), wb.objectRect(id, b)];
  for (const i of [0, 1]) {
    expect(after[i].x - before[i].x).toBeCloseTo(80, 0);
    expect(after[i].y).toBeCloseTo(before[i].y, 5);
  }
  grid.destroy();
});

it('still takes an object out of the selection with a Shift-click', async () => {
  const { a, b, grid, box } = await setup();
  pe(box(b), 'pointerdown', 100, 100, true); pe(box(b), 'pointerup', 100, 100, true);
  await flush();
  expect(grid.selectedCharts).toEqual([a]);
  grid.destroy();
});
