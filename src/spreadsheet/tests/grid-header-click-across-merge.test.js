// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));
const pointer = (target, type, init) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'mouse', ...init }));
const key = (target, k, init = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

async function setup() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.mergeCells(id, { r1: 0, c1: 0, r2: 0, c2: 7 }); // A1:H1
  wb.mergeCells(id, { r1: 3, c1: 0, r2: 6, c2: 0 }); // A4:A7
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  return { wb, id, grid };
}

// Excel selects just the clicked column or row; a merged block across it does not pull in the
// block's other lines, so Delete on the selection removes that one line and not the whole span.
it('selects only the clicked column when a merged block crosses it', async () => {
  const { grid } = await setup();
  const clip = grid.el.querySelector('.grid-colhead-clip');
  const head = clip.querySelector('.hcell[data-c="2"]');
  pointer(head, 'pointerdown', { clientX: 250, clientY: 10 });
  pointer(clip, 'pointerup', { clientX: 250, clientY: 10 });
  expect(grid.ranges).toEqual([{ r1: 0, c1: 2, r2: 1048575, c2: 2 }]);
  // C1 lies inside the block merged from A1, so typing goes into C2, a cell of the column that shows.
  expect(grid.active).toEqual({ r: 1, c: 2 });
  grid.destroy();
});

it('selects only the clicked row when a merged block crosses it', async () => {
  const { grid } = await setup();
  const clip = grid.el.querySelector('.grid-rowhead-clip');
  const head = clip.querySelector('.hcell[data-r="4"]');
  pointer(head, 'pointerdown', { clientX: 10, clientY: 120 });
  pointer(clip, 'pointerup', { clientX: 10, clientY: 120 });
  expect(grid.ranges).toEqual([{ r1: 4, c1: 0, r2: 4, c2: 16383 }]);
  expect(grid.active).toEqual({ r: 4, c: 1 });
  grid.destroy();
});

it('still grows a cell selection, and Ctrl+Space from a merged cell, to the merged block', async () => {
  const { grid } = await setup();
  const viewport = grid.el.querySelector('.grid-viewport');
  grid.selectByName('C1');
  expect(grid.range).toEqual({ r1: 0, c1: 0, r2: 0, c2: 7 });
  key(viewport, ' ', { ctrlKey: true, metaKey: true });
  expect(grid.range).toMatchObject({ r1: 0, c1: 0, c2: 7 });
  grid.selectByName('C2:D2');
  key(viewport, 'ArrowUp', { shiftKey: true });
  expect(grid.range).toEqual({ r1: 0, c1: 0, r2: 1, c2: 7 });
  grid.destroy();
});

it('deletes just the selected column, shrinking the merged block across it', async () => {
  const { wb, id } = await setup();
  wb.deleteCols(id, 2, 1);
  expect(wb.sheet(id).merges).toContainEqual({ r1: 0, c1: 0, r2: 0, c2: 6 });
  wb.insertCols(id, 2, 1);
  expect(wb.sheet(id).merges).toContainEqual({ r1: 0, c1: 0, r2: 0, c2: 7 });
});
