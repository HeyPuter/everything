// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// A form on a protected sheet leaves its entry cells unlocked. Excel's Tab moves between those cells there; here it
// stepped onto the locked labels beside them, where typing was refused, so filling the form in took the mouse or
// the arrows. Tab and Shift+Tab now go to the next and previous unlocked cell, round from the last to the first.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: t => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function ({ left, top }) { this.scrollLeft = left; this.scrollTop = top; };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
});
afterEach(() => { document.body.replaceChildren(); });

const frame = () => new Promise((r) => setTimeout(r, 5));
const cell = (r, c) => ({ r1: r, c1: c, r2: r, c2: c });

/** A form: labels in column A, entry cells B2, D2 and B4 unlocked, the sheet protected. */
async function form({ protect = true } = {}) {
  const wb = new Workbook({ sheets: [{ name: 'Form', rows: 40, cols: 12 }] });
  const id = wb.activeSheetId;
  wb.setInput(id, 1, 0, 'Name');
  wb.setInput(id, 1, 2, 'Phone');
  wb.setInput(id, 3, 0, 'Email');
  for (const [r, c] of [[1, 1], [1, 3], [3, 1]]) wb.applyStyle(id, cell(r, c), { locked: false });
  if (protect) wb.setSheetProtected(id, true);
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.append(grid.el);
  await frame();
  const viewport = grid.el.querySelector('.grid-viewport');
  viewport.focus();
  const tab = (shiftKey = false) => viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }));
  return { wb, id, grid, tab };
}
const at = (grid) => [grid.active.r, grid.active.c];

it('moves between the unlocked cells of a protected sheet, round from the last to the first', async () => {
  const { grid, tab } = await form();
  grid.setSelection({ active: { r: 0, c: 0 }, anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 } });
  tab();
  expect(at(grid)).toEqual([1, 1]);
  tab();
  expect(at(grid)).toEqual([1, 3]);
  tab();
  expect(at(grid)).toEqual([3, 1]);
  tab();
  expect(at(grid)).toEqual([1, 1]);
  tab(true);
  expect(at(grid)).toEqual([3, 1]);
  tab(true);
  expect(at(grid)).toEqual([1, 3]);
});

it('takes in a whole column left unlocked, and passes over hidden rows', async () => {
  const { wb, id, grid, tab } = await form();
  wb.setSheetProtected(id, false);
  wb.applyStyle(id, { r1: 0, c1: 5, r2: 1048575, c2: 5 }, { locked: false });
  wb.setHidden(id, 'row', [1], true);
  wb.setSheetProtected(id, true);
  grid.setSelection({ active: { r: 0, c: 0 }, anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 } });
  tab();
  expect(at(grid)).toEqual([0, 5]);
  tab();
  expect(at(grid)).toEqual([2, 5]);
  tab();
  expect(at(grid)).toEqual([3, 1]);
});

it('steps one cell along as before on a sheet that is not protected', async () => {
  const { grid, tab } = await form({ protect: false });
  grid.setSelection({ active: { r: 1, c: 1 }, anchor: { r: 1, c: 1 }, focus: { r: 1, c: 1 } });
  tab();
  expect(at(grid)).toEqual([1, 2]);
});
