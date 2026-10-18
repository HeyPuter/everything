// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { buildPrintSheet } from '../src/ui/print.js';
import { Workbook } from '../src/core/workbook.js';

// A picture or shape turned with Arrange ▸ Rotate turned its content inside a frame that stayed upright: a
// wide picture turned 90° stood up out of an empty, still-wide outline, and its selection frame and resize
// handle stayed where the picture no longer was (in print too). The whole box now turns about its centre,
// as a text box does and as the picture is saved, and its corner resizes it along its own sides.
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
const SRC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function setup(extra = {}) {
  const wb = new Workbook(), id = wb.sheets[0].id;
  const pic = wb.addChart(id, { type: 'image', src: SRC, title: 'Banner', anchor: { r: 6, c: 2 }, w: 300, h: 100, lockAspect: false, ...extra });
  wb.rotateObjects(id, [pic], 'right');
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  return { wb, id, pic, grid, box: grid.el.querySelector(`.chart-box[data-chart="${pic}"]`) };
}

it('turns a rotated picture’s whole box, frame and handles with it, and draws the picture upright inside', async () => {
  const { box, grid } = await setup();
  expect(box.style.transform).toMatch(/translate\([^)]*\) rotate\(90deg\) scale\(1, 1\)$/);
  const img = box.querySelector('.chart-body img');
  expect(img.style.transform).toBe('');
  grid.destroy();
});

it('turns a cropped picture’s box, not its content', async () => {
  const { box, grid } = await setup({ srcRect: { l: 0.1, t: 0, r: 0, b: 0 } });
  expect(box.style.transform).toMatch(/rotate\(90deg\)/);
  expect(box.querySelector('.chart-body svg').style.transform).toBe('');
  grid.destroy();
});

it('resizes a turned picture along its own sides from its corner', async () => {
  const { wb, id, pic, box, grid } = await setup();
  const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(box.style.transform), left = +m[1], top = +m[2];
  // Turned 90° clockwise about its centre, the box's bottom-right corner lies at the bottom-left on screen,
  // and the box's own width runs down the screen.
  const cx = left + 150, cy = top + 50, handle = [cx - 50, cy + 150];
  pe(box.querySelector('.chart-resize'), 'pointerdown', handle[0], handle[1]);
  pe(box, 'pointermove', handle[0] - 20, handle[1] + 40);
  pe(box, 'pointerup', handle[0] - 20, handle[1] + 40);
  await flush();
  expect([wb.chartById(id, pic).w, wb.chartById(id, pic).h]).toEqual([340, 120]);
  grid.destroy();
});

it('prints a rotated picture turned with its frame', () => {
  const wb = new Workbook(), id = wb.sheets[0].id;
  wb.setInput(id, 0, 0, 'x');
  const pic = wb.addChart(id, { type: 'image', src: SRC, title: 'Banner', anchor: { r: 1, c: 1 }, w: 300, h: 100, rotation: 90 });
  const node = buildPrintSheet(wb, id, {}).querySelector('.print-object');
  expect(node.style.transform).toBe('rotate(90deg) scale(1, 1)');
  expect(node.querySelector('img').style.transform).toBe('');
  expect(pic).toBeTruthy();
});
