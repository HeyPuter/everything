// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { createFormulaBar } from '../src/ui/formulabar.js';
import { Workbook } from '../src/core/workbook.js';
import * as notifications from '../src/ui/toast.js';

// Excel's Name Box and Go To take R1C1 references whichever style the sheet uses: R alone selects the active
// cell's row and C alone its column ("used as a shorthand for selecting a row or column for the currently
// selected cell", which is why no name may be R or C), R2C3 is C2, and R[1]C[-1] counts from the active cell.
// The box refused all of them as names: "That looks like a cell reference".
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

const key = (target, k, init = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

function setup() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const listeners = new Set();
  const grid = createGrid({ wb, sheetId: id, announce() {}, onCommand() {}, onSelection: () => { for (const fn of listeners) fn(); }, onEdit: () => { for (const fn of listeners) fn(); } });
  const bar = createFormulaBar({
    wb, grid, run() {}, announce() {}, goToName: () => false,
    sheetId: () => grid.sheetId, activeCell: () => wb.getCell(grid.sheetId, grid.active.r, grid.active.c),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  });
  document.body.replaceChildren(grid.el, bar.el);
  return { wb, grid, nameBox: bar.el.querySelector('.name-box') };
}

it.each([
  ['R', '5:5'], ['r', '5:5'], ['C', 'D:D'], ['c', 'D:D'],
  ['R2C3', 'C2'], ['r2c3', 'C2'], ['R[1]C', 'D6'], ['RC[-1]', 'C5'], ['R[-1]C[1]', 'E4'], ['RC', 'D5'],
  ['R1C1:R2C2', 'A1:B2'], ['R[-1]', '4:4'], ['C[1]', 'E:E'],
])('goes to %s from D5', async (text, where) => {
  const { wb, grid, nameBox } = setup();
  const toast = vi.spyOn(notifications, 'toast').mockImplementation(() => {});
  grid.selectByName('D5');
  nameBox.focus();
  nameBox.value = text;
  key(nameBox, 'Enter');
  await new Promise((r) => setTimeout(r, 5));
  expect(toast).not.toHaveBeenCalled();
  expect(wb.names).toHaveLength(0);
  expect(nameBox.value).toBe(where);
  expect(document.activeElement).toBe(grid.viewport);
});

it('still reads A1 references first (RC1 is a cell of column RC, R5 one of column R)', () => {
  const { grid } = setup();
  expect(grid.selectByName('RC1')).toBe(true);
  expect(grid.range).toEqual({ r1: 0, c1: 470, r2: 0, c2: 470 });
  expect(grid.selectByName('R5')).toBe(true);
  expect(grid.range).toEqual({ r1: 4, c1: 17, r2: 4, c2: 17 });
});

it('refuses an R1C1 reference off the sheet', () => {
  const { grid } = setup();
  expect(grid.selectByName('R0C1')).toBe(false);
  expect(grid.selectByName('R[-1]C')).toBe(false); // from A1
});
