// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// A viewport laid out as a browser does: 832px wide less the row headings' width the grid sets on its root, and
// a scroll the browser pulls back whenever it would show past the end of the canvas, at every layout: when the
// scroll is read, and when styles are read (as getComputedStyle brings the layout up to date in a browser).
let observers;
let grid;
const realComputedStyle = window.getComputedStyle;
beforeEach(() => {
  observers = [];
  const headings = () => parseFloat(grid?.el.style.getPropertyValue('--row-header-w')) || 32;
  const width = (el) => (el.classList?.contains('grid-viewport') ? 832 - headings() : 800);
  const extent = (el) => parseFloat(el.querySelector('.grid-canvas')?.style.width) || 0;
  const clampLeft = (el) => { el._sl = Math.max(0, Math.min(el._sl || 0, extent(el) - width(el))); return el._sl; };
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return width(this); } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  Object.defineProperty(Element.prototype, 'scrollLeft', { configurable: true, get() { return clampLeft(this); }, set(v) { this._sl = v; } });
  Element.prototype.scrollTo = function scrollTo(o) { this._sl = o.left; clampLeft(this); };
  window.getComputedStyle = (el, ...rest) => { for (const vp of document.querySelectorAll('.grid-viewport')) clampLeft(vp); return realComputedStyle(el, ...rest); };
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() {} unobserve() {} };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => {
  delete globalThis.ResizeObserver;
  delete Element.prototype.scrollLeft;
  window.getComputedStyle = realComputedStyle;
  document.body.replaceChildren();
  grid = null;
});

const flush = () => new Promise((r) => setTimeout(r, 5));
const resized = () => { for (const o of observers) o.cb([]); };

// Going to XFD1048576 widens the row headings for seven-digit numbers, which resizes the viewport. On a resize
// the grid took its headings' sizes off its root to read the stylesheet's: the viewport was laid out wider for
// that moment, the browser pulled the scroll back to fit it at the canvas's end, and the scroll stayed there
// once the sizes were put back, so the last column was cut off by the headings' extra width.
it('a resize keeps the sheet scrolled to its last column', async () => {
  const wb = new Workbook();
  grid = createGrid({ wb, sheetId: wb.sheets[0].id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  grid.selectByName('XFD1048576');
  await flush();
  const vp = grid.viewport;
  const canvas = parseFloat(vp.querySelector('.grid-canvas').style.width);
  expect(vp.clientWidth).toBeLessThan(800); // the headings widened for the long row numbers
  expect(vp.scrollLeft).toBe(canvas - vp.clientWidth);
  resized();
  await flush();
  // The last column's right edge still meets the viewport's.
  expect(vp.scrollLeft).toBe(canvas - vp.clientWidth);
});
