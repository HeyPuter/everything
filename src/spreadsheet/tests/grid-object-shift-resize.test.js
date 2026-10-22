// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// Shift held while dragging a chart's (or text box's) corner kept its proportions only for pictures: a chart
// stretched freely, so it could not be made larger without distorting it, as Excel's Shift-drag allows.
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

async function resize(obj, shiftKey) {
  const wb = new Workbook(), id = wb.sheets[0].id;
  const oid = wb.addChart(id, { anchor: { r: 2, c: 2 }, ...obj });
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  const box = grid.el.querySelector(`.chart-box[data-chart="${oid}"]`);
  pe(box.querySelector('.chart-resize'), 'pointerdown', 500, 300);
  pe(box, 'pointermove', 580, 310, shiftKey);
  pe(box, 'pointerup', 580, 310, shiftKey);
  await flush();
  const { w, h } = wb.chartById(id, oid);
  grid.destroy();
  return [w, h];
}

it.each([
  ['chart', { type: 'column', range: { r1: 0, c1: 0, r2: 2, c2: 1 }, w: 400, h: 200 }],
  ['text box', { type: 'text', text: 'Note', w: 200, h: 100 }],
])('keeps a %s in proportion while Shift is held, and stretches it freely without', async (_, obj) => {
  expect(await resize(obj, true)).toEqual([obj.w + 80, (obj.w + 80) * obj.h / obj.w]);
  expect(await resize(obj, false)).toEqual([obj.w + 80, obj.h + 10]);
});
