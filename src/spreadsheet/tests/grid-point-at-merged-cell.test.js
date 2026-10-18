// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// Pointing at a merged block while typing a formula put in the address of whichever cell under the block was
// clicked or reached with the arrows: =B2 for a click in the middle of a title merged over A1:C3, a cell that is
// empty under the block, so the formula read nothing. A merged block is one cell, named by its top-left corner,
// as Excel and Sheets point at it; its reference is outlined over the whole block, and a range pointed through
// a block takes it in whole.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: t => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function ({ left, top }) { this.scrollLeft = left; this.scrollTop = top; };
  Element.prototype.setPointerCapture = function () {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
});
afterEach(() => { document.body.replaceChildren(); });

function mount() {
  const wb = new Workbook({ sheets: [{ name: 'Data', rows: 100, cols: 20 }] });
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Title');
  wb.mergeCells(id, { r1: 0, c1: 0, r2: 2, c2: 2 });
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.append(grid.el);
  grid.viewport.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 });
  const editor = grid.el.querySelector('.grid-editor');
  const key = (k, init = {}) => editor.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  const press = (r, c, init = {}) => {
    const rect = grid.cellRect(r, c);
    for (const type of ['pointerdown', 'pointerup']) grid.viewport.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'mouse', clientX: rect.left + 3, clientY: rect.top + 3, ...init }));
  };
  return { wb, id, grid, key, press };
}

it('puts in the merged block\'s own address for a click anywhere on it', () => {
  const { grid, press } = mount();
  grid.selectByName('E5');
  grid.beginEdit({ text: '=', mode: 'type' });
  press(1, 1); // B2, under the block
  expect(grid.editState.text).toBe('=A1');
  // The reference is outlined over the whole block.
  const hl = grid.el.querySelector('.ref-hl');
  const block = grid.cellRect(2, 2);
  expect(parseFloat(hl.style.width)).toBe(block.right - grid.cellRect(0, 0).left);
  expect(parseFloat(hl.style.height)).toBe(block.bottom - grid.cellRect(0, 0).top);
  grid.destroy();
});

it('names the block when the arrows reach it, and steps off it from its far side', () => {
  const { grid, key } = mount();
  grid.selectByName('E3');
  grid.beginEdit({ text: '=', mode: 'type' });
  key('ArrowLeft'); // D3
  expect(grid.editState.text).toBe('=D3');
  key('ArrowLeft'); // into the block
  expect(grid.editState.text).toBe('=A1');
  key('ArrowDown'); // off its bottom edge, in the column the arrows came along
  expect(grid.editState.text).toBe('=C4');
  grid.destroy();
});

it('takes in a merged block whole when a pointed range cuts through it', () => {
  const { grid, key } = mount();
  grid.selectByName('B6');
  grid.beginEdit({ text: '=SUM(', mode: 'type' });
  key('ArrowUp'); // B5
  key('ArrowUp', { shiftKey: true }); // B4:B5
  key('ArrowUp', { shiftKey: true }); // B3:B5, into the block
  expect(grid.editState.text).toBe('=SUM(A1:C5');
  grid.destroy();
});
