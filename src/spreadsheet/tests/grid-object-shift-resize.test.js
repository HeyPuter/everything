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

// Snap to Grid (and Snap to Shape) lined up an object's box when it was moved, but its corner went anywhere
// when it was resized, so a chart could not be sized to the cells it was dragged onto them with.
it('takes the corner dragged to the nearest cell edge with Snap to Grid on, and leaves it free with Alt', async () => {
  const drag = async (altKey) => {
    const wb = new Workbook(), id = wb.sheets[0].id, sheet = wb.sheets[0];
    const oid = wb.addChart(id, { type: 'text', text: 'Note', anchor: { r: 2, c: 2 }, w: 200, h: 100 });
    const grid = createGrid({ wb, sheetId: id, announce() {}, snap: () => ({ grid: true, shape: false }) });
    document.body.replaceChildren(grid.el);
    await flush();
    const box = grid.el.querySelector(`.chart-box[data-chart="${oid}"]`);
    const at = wb.objectRect(id, oid), colW = sheet.defaultColWidth, rowH = sheet.defaultRowHeight;
    // 5px short of a column edge across, 4px past a row edge down.
    const right = Math.ceil((at.x + at.w) / colW + 1) * colW - 5, bottom = Math.ceil((at.y + at.h) / rowH + 1) * rowH + 4;
    pe(box.querySelector('.chart-resize'), 'pointerdown', 500, 300);
    pe(box, 'pointermove', 500 + right - (at.x + at.w), 300 + bottom - (at.y + at.h), false);
    box.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 500 + right - (at.x + at.w), clientY: 300 + bottom - (at.y + at.h), pointerId: 1, altKey }));
    pe(box, 'pointerup', 500 + right - (at.x + at.w), 300 + bottom - (at.y + at.h));
    await flush();
    const { w, h } = wb.chartById(id, oid);
    grid.destroy();
    return [at.x + w, at.y + h, right, bottom, colW, rowH];
  };
  const [x, , right, , colW] = await drag(false);
  expect(x).toBe(right + 5);
  expect(x % colW).toBe(0);
  const free = await drag(true);
  expect(free[0]).toBe(free[2]);
  expect(Math.abs(free[1] - free[3])).toBeLessThan(1);
});

// Moving or resizing a picture or text box was named "Move chart" and "Resize chart" in the Undo button's tip
// and the undo history; each names its own kind of object now.
it('names the kind of object moved or resized in the undo history', async () => {
  const wb = new Workbook(), id = wb.sheets[0].id;
  const oid = wb.addChart(id, { type: 'text', text: 'Note', anchor: { r: 2, c: 2 }, w: 200, h: 100 });
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  const box = grid.el.querySelector(`.chart-box[data-chart="${oid}"]`);
  pe(box.querySelector('.chart-resize'), 'pointerdown', 500, 300); pe(box, 'pointermove', 520, 310); pe(box, 'pointerup', 520, 310);
  await flush();
  expect(wb.undoLabel()).toBe('Resize text box');
  pe(box, 'pointerdown', 100, 100); pe(box, 'pointermove', 140, 100); pe(box, 'pointerup', 140, 100);
  await flush();
  expect(wb.undoLabel()).toBe('Move text box');
  grid.destroy();
});

// Alt held while dragging only let an object go free when snapping was on; with it off (the default), Alt did
// nothing, where in Excel it is the way to line a chart up with the cells.
it('takes the corner to the cell edges with Alt held while snapping is off', async () => {
  const wb = new Workbook(), id = wb.sheets[0].id, sheet = wb.sheets[0];
  const oid = wb.addChart(id, { type: 'text', text: 'Note', anchor: { r: 2, c: 2 }, w: 200, h: 100 });
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  const box = grid.el.querySelector(`.chart-box[data-chart="${oid}"]`);
  const at = wb.objectRect(id, oid), colW = sheet.defaultColWidth;
  const right = Math.ceil((at.x + at.w) / colW + 1) * colW - 5, move = right - (at.x + at.w);
  pe(box.querySelector('.chart-resize'), 'pointerdown', 500, 300);
  box.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 500 + move, clientY: 300, pointerId: 1, altKey: true }));
  pe(box, 'pointerup', 500 + move, 300);
  await flush();
  expect(at.x + wb.chartById(id, oid).w).toBe(right + 5);
  grid.destroy();
});
