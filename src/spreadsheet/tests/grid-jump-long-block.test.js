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
const column = (n, at = (r) => r) => { const cells = {}; for (let r = 0; r < n; r++) cells[`${at(r)},0`] = { v: r + 1 }; return cells; };

async function mount(sheet) {
  const wb = new Workbook({ sheets: [{ name: 'Data', ...sheet }] });
  const id = wb.sheets[0].id;
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  return { wb, id, grid };
}

// Ctrl+Down from the top of a column filled a million rows down looked at every cell of it, one by one: 400ms a
// press in Chromium. The stretch of stored values ahead is now crossed in one leap.
it('Ctrl+Down and Ctrl+Up cross a long filled column without visiting every cell', async () => {
  const { wb, grid } = await mount({ cells: column(20000) });
  const getCell = wb.getCell.bind(wb);
  let reads = 0;
  wb.getCell = (...args) => { reads++; return getCell(...args); };
  grid.selectByName('A1');
  press(grid, 'ArrowDown', { ctrlKey: true });
  expect(grid.active).toEqual({ r: 19999, c: 0 });
  press(grid, 'ArrowUp', { ctrlKey: true });
  expect(grid.active).toEqual({ r: 0, c: 0 });
  grid.selectByName('A10');
  press(grid, 'ArrowDown', { ctrlKey: true, shiftKey: true });
  expect(grid.range).toEqual({ r1: 9, c1: 0, r2: 19999, c2: 0 });
  expect(reads).toBeLessThan(1000);
  grid.destroy();
});

it('the leap stops where the walk would: at a gap, at the last row on show, and before a merged block', async () => {
  // A gap at row 3001 (index 3000): the block ends at A3000.
  let { grid } = await mount({ cells: column(6000, (r) => (r >= 3000 ? r + 1 : r)) });
  grid.selectByName('A1');
  press(grid, 'ArrowDown', { ctrlKey: true });
  expect(grid.active).toEqual({ r: 2999, c: 0 });
  press(grid, 'ArrowDown', { ctrlKey: true });
  expect(grid.active).toEqual({ r: 3001, c: 0 });
  press(grid, 'ArrowDown', { ctrlKey: true });
  expect(grid.active).toEqual({ r: 6000, c: 0 });
  press(grid, 'ArrowUp', { ctrlKey: true });
  expect(grid.active).toEqual({ r: 3001, c: 0 });
  grid.destroy();

  // The block's last rows hidden: the jump stops on the last row on show.
  ({ grid } = await mount({ cells: column(3000), hiddenRows: [2997, 2998, 2999] }));
  grid.selectByName('A1');
  press(grid, 'ArrowDown', { ctrlKey: true });
  expect(grid.active).toEqual({ r: 2996, c: 0 });
  grid.destroy();

  // Rows hidden inside the block are passed over, as the walk passes them.
  ({ grid } = await mount({ cells: column(3000, (r) => (r >= 1500 ? r + 3 : r)), hiddenRows: [1500, 1501, 1502] }));
  grid.selectByName('A1');
  press(grid, 'ArrowDown', { ctrlKey: true });
  expect(grid.active).toEqual({ r: 3002, c: 0 });
  grid.destroy();

  // A merged block whose anchor is empty, a value stored under it: its cells hold what the anchor holds, nothing,
  // so the block of data ends above it, going down and going up.
  const cells = column(3000);
  delete cells['1500,0'];
  ({ grid } = await mount({ cells, merges: [{ r1: 1500, c1: 0, r2: 1501, c2: 1 }] }));
  grid.selectByName('A1');
  press(grid, 'ArrowDown', { ctrlKey: true });
  expect(grid.active).toEqual({ r: 1499, c: 0 });
  grid.selectByName('A3000');
  press(grid, 'ArrowUp', { ctrlKey: true });
  expect(grid.active).toEqual({ r: 1502, c: 0 });
  grid.destroy();
});
