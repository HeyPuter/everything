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
const press = (grid, key, init = {}) => grid.viewport.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));

// Enter walks the active cell down the columns of a selection, passing over hidden rows. With columns
// A:B selected and every row below row 10 hidden, Enter on A10 looked at each of the million hidden rows
// below it before going on to B1 (a fifth of a second a press); Shift+Enter on B1 did the same going back.
it('Enter and Shift+Enter in whole columns pass rows hidden to the end of the sheet in one leap', async () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const rows = [];
  for (let r = 10; r < 1048576; r++) rows.push(r);
  wb.setHidden(id, 'row', [3, 4], true);
  wb.setHidden(id, 'row', rows, true);
  wb.ensureSize(id, 1048576, 0);
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  await flush();
  const hidden = wb.sheet(id).hiddenRows;
  const has = hidden.has.bind(hidden);
  let lookups = 0;
  hidden.has = (r) => { lookups++; return has(r); };

  grid.selectByName('A:B');
  const walk = [];
  for (let i = 0; i < 9; i++) { press(grid, 'Enter'); walk.push(grid.selection.active.r); }
  expect(walk).toEqual([1, 2, 5, 6, 7, 8, 9, 0, 1]);
  expect(grid.selection.active).toEqual({ r: 1, c: 1 });
  press(grid, 'Enter', { shiftKey: true });
  press(grid, 'Enter', { shiftKey: true });
  expect(grid.selection.active).toEqual({ r: 9, c: 0 });
  expect(grid.ranges).toEqual([{ r1: 0, c1: 0, r2: 1048575, c2: 1 }]);
  expect(lookups).toBeLessThan(5000);
  grid.destroy();
});
