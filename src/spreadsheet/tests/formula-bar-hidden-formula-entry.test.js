// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { createFormulaBar } from '../src/ui/formulabar.js';
import { Workbook } from '../src/core/workbook.js';

// On a protected sheet, a cell left unlocked whose formula is hidden (Format Cells ▸ Protection ▸ Hidden) shows an
// empty formula bar. Clicking into the bar began the entry from that empty text, so clicking away again (or
// pressing Enter) wrote nothing over the formula and it was gone. The entry now starts from the formula, as F2
// in the cell does; the bar is empty again once it ends.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
let teardown = null;
afterEach(() => { teardown?.(); teardown = null; document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));

function setup({ locked = false } = {}) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 0, 0, '=1+1');
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { locked, formulaHidden: true });
  wb.setSheetProtected(id, true);
  const listeners = new Set();
  const grid = createGrid({ wb, sheetId: id, announce() {}, onCommand() {}, onSelection: () => { for (const fn of listeners) fn(); }, onEdit: () => { for (const fn of listeners) fn(); } });
  const ctx = {
    wb, grid, run() {}, announce() {}, goToName: () => false,
    sheetId: () => grid.sheetId, range: () => grid.range, ranges: () => grid.ranges,
    activeCell: () => wb.getCell(grid.sheetId, grid.active.r, grid.active.c),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const bar = createFormulaBar(ctx);
  document.body.replaceChildren(grid.el, bar.el);
  teardown = () => { bar.destroy(); grid.destroy(); };
  return { wb, id, grid, input: bar.el.querySelector('.formula-input') };
}

it('keeps the formula when the bar is clicked into and left', async () => {
  const { wb, id, grid, input } = setup();
  expect(input.value).toBe('');
  input.focus();
  expect(grid.editing).toBe(true);
  expect(input.value).toBe('=1+1');
  input.blur();
  document.body.focus();
  await flush();
  expect(grid.editing).toBe(false);
  expect(wb.getCell(id, 0, 0).f).toBe('1+1');
  expect(wb.getValue(id, 0, 0)).toBe(2);
  expect(input.value).toBe('');
});

it('keeps the formula when the bar is clicked into and Enter pressed', () => {
  const { wb, id, input } = setup();
  input.focus();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect(wb.getCell(id, 0, 0).f).toBe('1+1');
});

it('still shows nothing of a locked cell\'s hidden formula', () => {
  const { grid, input } = setup({ locked: true });
  input.focus();
  expect(grid.editing).toBe(false);
  expect(input.value).toBe('');
});
