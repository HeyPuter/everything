// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.setPointerCapture = function () {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));
const key = (target, k, init = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

it('Shift+Home extends a multi-row selection to the first column without dropping its rows', async () => {
  const wb = new Workbook();
  const grid = createGrid({ wb, sheetId: wb.sheets[0].id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  const viewport = grid.el.querySelector('.grid-viewport');
  grid.selectByName('C2');
  key(viewport, 'ArrowDown', { shiftKey: true });
  key(viewport, 'ArrowDown', { shiftKey: true });
  expect(grid.range).toEqual({ r1: 1, c1: 2, r2: 3, c2: 2 });
  key(viewport, 'Home', { shiftKey: true });
  expect(grid.range).toEqual({ r1: 1, c1: 0, r2: 3, c2: 2 });
  expect(grid.active).toEqual({ r: 1, c: 2 });
  // Plain Home still goes to the active cell's row.
  key(viewport, 'Home');
  expect(grid.range).toEqual({ r1: 1, c1: 0, r2: 1, c2: 0 });
  grid.destroy();
});
