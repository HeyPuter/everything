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


function mount() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  for (let r = 0; r < 10; r++) for (let c = 0; c < 5; c++) wb.setInput(id, r, c, 'x');
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  const press = (key, extra = {}) => grid.viewport.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
  return { grid, press };
}
const jump = { shiftKey: true, ctrlKey: true, metaKey: true };

// Whole rows end at the sheet's last column, and whole columns at its last row, where nothing is: Ctrl+Shift+Down
// from rows 2:3 ran from that empty column to the sheet's last row, not to the end of the data under them.
it('stretches whole rows to the end of the data in the active cell\'s column', () => {
  const { grid, press } = mount();
  grid.selectByName('B2');
  press(' ', { shiftKey: true });
  press('ArrowDown', { shiftKey: true });
  press('ArrowDown', jump);
  expect(grid.formatRanges.at(-1)).toMatchObject({ r1: 1, r2: 9, c1: 0, scope: 'rows' });
  expect(grid.active).toEqual({ r: 1, c: 1 });
});

it('stretches whole columns to the end of the data in the active cell\'s row', () => {
  const { grid, press } = mount();
  grid.selectByName('B2');
  press(' ', { ctrlKey: true, metaKey: true });
  press('ArrowRight', jump);
  expect(grid.formatRanges.at(-1)).toMatchObject({ c1: 1, c2: 4, r1: 0, scope: 'columns' });
});

it('does the same with End, then Shift+arrow', () => {
  const { grid, press } = mount();
  grid.selectByName('B2');
  press(' ', { shiftKey: true });
  press('End');
  press('ArrowDown', { shiftKey: true });
  expect(grid.formatRanges.at(-1)).toMatchObject({ r1: 1, r2: 9, scope: 'rows' });
});

// Excel's Ctrl+Shift+arrow extends "to the last nonblank cell in the same column or row as the active cell": a
// header row selected from A1 to C1 stretched down column C instead, stopping at its first gap.
it('stretches a range down the active cell\'s column, keeping its width', () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  for (let r = 0; r < 10; r++) wb.setInput(id, r, 0, 'a');
  for (let r = 0; r < 3; r++) wb.setInput(id, r, 2, 'c'); // C has a gap after C3
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  grid.selectByName('A1:C1');
  grid.viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true, ...jump }));
  expect(grid.range).toEqual({ r1: 0, c1: 0, r2: 9, c2: 2 });
  expect(grid.active).toEqual({ r: 0, c: 0 });
  grid.viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true, ...jump }));
  expect(grid.range).toEqual({ r1: 0, c1: 0, r2: 0, c2: 2 });
});
