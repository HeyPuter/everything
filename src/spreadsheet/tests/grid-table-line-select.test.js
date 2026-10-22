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


function mount({ totals = false } = {}) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  ['Item', 'Qty', 'Price'].forEach((h, c) => wb.setInput(id, 1, 1 + c, h));
  for (let r = 2; r <= 5; r++) for (let c = 1; c <= 3; c++) wb.setInput(id, r, c, String(r * c));
  wb.addTable(id, { r1: 1, c1: 1, r2: 5, c2: 3 }, { totalsRow: totals });
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  const press = (init) => grid.viewport.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true, ...init }));
  return { wb, id, grid, press };
}
const ctrlSpace = { ctrlKey: true, metaKey: true };

// Ctrl+Space and Shift+Space went straight to the sheet's whole column or row, inside a table too: Excel selects the
// table's own column (its data, then with its header) or row first, the way a table's column is formatted or copied.
it('selects a table column\'s data, then with its header, then the whole column, with Ctrl+Space', () => {
  const { grid, press } = mount();
  grid.selectByName('C4');
  press(ctrlSpace);
  expect(grid.range).toEqual({ r1: 2, c1: 2, r2: 5, c2: 2 });
  expect(grid.active).toEqual({ r: 3, c: 2 });
  press(ctrlSpace);
  expect(grid.range).toEqual({ r1: 1, c1: 2, r2: 5, c2: 2 });
  press(ctrlSpace);
  expect(grid.formatRanges.at(-1)).toMatchObject({ c1: 2, c2: 2, r1: 0, scope: 'columns' });
});

it('selects a table row, then the whole row, with Shift+Space', () => {
  const { grid, press } = mount();
  grid.selectByName('C4');
  press({ shiftKey: true });
  expect(grid.range).toEqual({ r1: 3, c1: 1, r2: 3, c2: 3 });
  press({ shiftKey: true });
  expect(grid.formatRanges.at(-1)).toMatchObject({ r1: 3, r2: 3, c1: 0, scope: 'rows' });
});

it('selects whole lines at once outside a table, as before', () => {
  const { grid, press } = mount();
  grid.selectByName('H4');
  press(ctrlSpace);
  expect(grid.formatRanges.at(-1)).toMatchObject({ c1: 7, c2: 7, scope: 'columns' });
});
