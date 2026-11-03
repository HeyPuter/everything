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

// With column C hidden, C1:D1 gone to by name and then Shift+Left, B1:C1 is selected and the active cell went
// back to the anchor, C1, in the hidden column. A shown cell was looked for only after it, D1, outside the range,
// so the active cell stayed hidden: an entry typed went into a cell nobody could see. It now looks before too.
it('the active cell of a range finds a shown cell before it when the range ends first', async () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setHidden(id, 'col', [2], true);
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  await flush();
  grid.selectByName('C1:D1');
  expect(grid.selection.active).toEqual({ r: 0, c: 3 });
  press(grid, 'ArrowLeft', { shiftKey: true });
  expect(grid.ranges).toEqual([{ r1: 0, c1: 1, r2: 0, c2: 2 }]);
  expect(grid.selection.active).toEqual({ r: 0, c: 1 });

  // Rows too: row 3 hidden, A3:A4 by name, Shift+Up to A2:A3.
  wb.setHidden(id, 'col', [2], false);
  wb.setHidden(id, 'row', [2], true);
  grid.selectByName('A3:A4');
  press(grid, 'ArrowUp', { shiftKey: true });
  expect(grid.ranges).toEqual([{ r1: 1, c1: 0, r2: 2, c2: 0 }]);
  expect(grid.selection.active).toEqual({ r: 1, c: 0 });
  grid.destroy();
});

// Column A hidden and A6:B6 merged: A9:A10 by name (all hidden, so A9 stays active), whole column A, then
// Shift+Up, is A1:A1048575, which the merge widens to take in column B. Only column A was looked in for a
// shown cell, so the active cell stayed in the hidden column.
it('the active cell of a range finds a shown cell in the columns a merged block brings into it', async () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setHidden(id, 'col', [0], true);
  wb.mergeCells(id, { r1: 5, c1: 0, r2: 5, c2: 1 });
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  await flush();
  grid.selectByName('A9:A10');
  expect(grid.selection.active).toEqual({ r: 8, c: 0 });
  press(grid, ' ', { ctrlKey: true, code: 'Space' });
  press(grid, 'ArrowUp', { shiftKey: true });
  expect(grid.ranges).toEqual([{ r1: 0, c1: 0, r2: 1048574, c2: 1 }]);
  expect(grid.selection.active).toEqual({ r: 8, c: 1 });
  grid.destroy();
});
