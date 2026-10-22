// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// A text box turned 90° (Arrange ▸ Rotate) or flipped grew along the screen's axes when its corner was
// dragged, not its own: dragging the corner sideways made the box taller, and the box slid away under
// the pointer. Its own sides now grow, and the opposite corner stays where it is on screen.
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
const pe = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0 }));

/** The four corners on screen of a w × h box at (left, top) turned by `deg` (and flipped) about its centre. */
const corners = ({ left, top, w, h }, deg, flipH = false) => {
  const a = deg * Math.PI / 180, cx = left + w / 2, cy = top + h / 2, sx = flipH ? -1 : 1;
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => [x * sx, y])
    .map(([x, y]) => [Math.round(cx + x * Math.cos(a) - y * Math.sin(a)), Math.round(cy + x * Math.sin(a) + y * Math.cos(a))]);
};

it.each([[90, false], [270, false], [180, false], [0, true]])('resizes a text box turned %i° (flipped: %s) along its own sides', async (rotation, flipH) => {
  const wb = new Workbook(), id = wb.sheets[0].id;
  const text = wb.addChart(id, { type: 'text', text: 'Note', anchor: { r: 6, c: 4 }, w: 200, h: 80, rotation, flipH });
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  const box = grid.el.querySelector(`.chart-box[data-chart="${text}"]`);
  const rect = () => { const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(box.style.transform); return { left: +m[1], top: +m[2], w: parseFloat(box.style.width), h: parseFloat(box.style.height) }; };
  const before = rect();
  // The corner handle is the box's own bottom-right; on screen it lies at the turned corner.
  const [, , handle] = corners(before, rotation, flipH);
  const anchor = corners(before, rotation, flipH)[0];
  const corner = box.querySelector('.chart-resize');
  pe(corner, 'pointerdown', handle[0], handle[1]);
  // Drag the handle 40px further out along the box's own width and 20px along its height.
  const a = rotation * Math.PI / 180, sx = flipH ? -1 : 1;
  const out = [40 * sx * Math.cos(a) - 20 * Math.sin(a), 40 * sx * Math.sin(a) + 20 * Math.cos(a)];
  pe(box, 'pointermove', handle[0] + out[0], handle[1] + out[1]);
  pe(box, 'pointerup', handle[0] + out[0], handle[1] + out[1]);
  await flush();
  const ch = wb.chartById(id, text);
  expect([ch.w, ch.h]).toEqual([240, 100]);
  expect(corners(rect(), rotation, flipH)[0].map((v, i) => Math.abs(v - anchor[i]) <= 1)).toEqual([true, true]);
  expect(wb.undoLabel()).toBe('Resize text box');
  grid.destroy();
});

it('resizes an upright text box from its top-left as before', async () => {
  const wb = new Workbook(), id = wb.sheets[0].id;
  const text = wb.addChart(id, { type: 'text', text: 'Note', anchor: { r: 6, c: 4 }, dx: 3, dy: 2, w: 200, h: 80 });
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  const box = grid.el.querySelector(`.chart-box[data-chart="${text}"]`);
  const corner = box.querySelector('.chart-resize');
  pe(corner, 'pointerdown', 500, 300);
  pe(box, 'pointermove', 530, 310);
  pe(box, 'pointerup', 530, 310);
  await flush();
  expect(wb.chartById(id, text)).toMatchObject({ anchor: { r: 6, c: 4 }, dx: 3, dy: 2, w: 230, h: 90 });
  grid.destroy();
});
