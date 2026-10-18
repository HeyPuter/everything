// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

let height;
let scrolls;
let observers;
beforeEach(() => {
  height = 400;
  scrolls = [];
  observers = [];
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return height; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo(o) { scrolls.push(o); };
  Element.prototype.setPointerCapture = function () {};
  globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() {} unobserve() {} };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { delete globalThis.ResizeObserver; document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));
const resized = () => { for (const o of observers) o.cb([]); };

// On a phone the on-screen keyboard opens as editing begins and takes the lower part of the screen: the
// grid's viewport shrinks, and the cell being typed into, low on the screen, ended up under the keyboard.
it('a cell being edited stays in view when the viewport shrinks under it', async () => {
  const wb = new Workbook();
  const grid = createGrid({ wb, sheetId: wb.sheets[0].id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  grid.selectByName('B16');
  await flush();
  resized(); // the size the grid opened at
  grid.beginEdit({ mode: 'inplace' });
  scrolls.length = 0;
  height = 100;
  resized();
  // Row 16 lies well below the 100px left: the sheet scrolls down to it.
  expect(scrolls.length).toBeGreaterThan(0);
  expect(scrolls.at(-1).top).toBeGreaterThan(0);
  expect(grid.editing).toBeTruthy();
  grid.destroy();
});

it('without an edit a resize leaves the scroll alone', async () => {
  const wb = new Workbook();
  const grid = createGrid({ wb, sheetId: wb.sheets[0].id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  grid.selectByName('B16');
  await flush();
  resized();
  scrolls.length = 0;
  height = 100;
  resized();
  expect(scrolls).toEqual([]);
  grid.destroy();
});
