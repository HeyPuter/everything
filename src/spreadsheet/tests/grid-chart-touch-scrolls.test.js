// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';
import { stylesheet, declared } from './helpers/css.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 375; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 600; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));
const pe = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 3, button: 0, pointerType: 'touch' }));

async function setup() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 0, 0, '1');
  wb.setInput(id, 1, 0, '2');
  const chartId = wb.addChart(id, { type: 'column', range: { r1: 0, c1: 0, r2: 1, c2: 0 }, anchor: { r: 1, c: 2 }, dx: 10, dy: 5, w: 480, h: 288 });
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  return { wb, id, chartId, grid, steps: wb.undoLabels().length, box: grid.el.querySelector(`.chart-box[data-chart="${chartId}"]`) };
}

// On a phone a chart is wider than the screen, and a finger swiping across it to scroll the sheet
// took hold of the chart instead: it selected it and slid it over the data, and the sheet did not
// scroll. A finger on an object not selected now scrolls the sheet and a tap selects the object, as
// the cells take a finger; a selected object still moves under one.
it('lets a finger swiping across a chart not selected scroll the sheet, leaving the chart in place', async () => {
  const { wb, id, chartId, grid, steps, box } = await setup();
  const css = stylesheet('grid.css');
  expect(declared(css, '.chart-box', false)['touch-action']).toBeUndefined();
  pe(box, 'pointerdown', 330, 120);
  pe(box, 'pointermove', 250, 122);
  pe(box, 'pointercancel', 250, 122); // the browser took the swipe for a scroll
  await flush();
  expect(wb.chartById(id, chartId)).toMatchObject({ anchor: { r: 1, c: 2 }, dx: 10, dy: 5 });
  expect(wb.undoLabels().length).toBe(steps);
  expect(grid.selectedChart).toBeFalsy();
  expect(box.classList.contains('selected')).toBe(false);
  grid.destroy();
});

it('selects a chart with a tap, and then moves it with a drag', async () => {
  const { wb, id, chartId, grid, box } = await setup();
  pe(box, 'pointerdown', 300, 120);
  pe(box, 'pointerup', 302, 121);
  await flush();
  expect(grid.selectedChart).toBe(chartId);
  expect(box.classList.contains('selected')).toBe(true);
  pe(box, 'pointerdown', 300, 120);
  pe(box, 'pointermove', 340, 120);
  pe(box, 'pointerup', 340, 120);
  await flush();
  expect(wb.chartById(id, chartId).dx).toBe(50);
  grid.destroy();
});

it('does not select a chart a finger came down on and lifted far away from', async () => {
  const { grid, box } = await setup();
  pe(box, 'pointerdown', 300, 120);
  pe(box, 'pointerup', 200, 160);
  await flush();
  expect(grid.selectedChart).toBeFalsy();
  grid.destroy();
});
