// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// A number given no alignment is edited aligned right, as it is drawn, but the box it was edited in grew to
// the right like a left-aligned entry's: a long number typed in with F2 ran away from its cell, its digits
// pushed against the far end of a box reaching two or three cells past it. The box now grows left from a
// number, ending at the cell's right edge, as it already did from a cell aligned right.
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

function editNumber(input) {
  const wb = new Workbook({ sheets: [{ name: 'Data', rows: 100, cols: 20 }] });
  const id = wb.activeSheetId;
  wb.setInput(id, 4, 4, input);
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.append(grid.el);
  grid.selectByName('E5');
  grid.beginEdit({ mode: 'inplace' });
  grid.setEditText(`${input}${'1234567890'.repeat(3)}`);
  const editor = grid.el.querySelector('.grid-editor');
  const cell = grid.cellRect(4, 4);
  const left = parseFloat(editor.style.left), width = parseFloat(editor.style.width);
  const cellLeft = cell.left + grid.viewport.scrollLeft;
  return { grid, editor, left, right: left + width, cellLeft, cellRight: cellLeft + cell.width };
}

it('grows left from a number edited in place, its digits staying at the cell\'s right edge', () => {
  const { grid, editor, left, right, cellLeft, cellRight } = editNumber('5');
  expect(editor.style.textAlign).toBe('right');
  expect(right).toBe(cellRight);
  expect(left).toBeLessThan(cellLeft);
  grid.destroy();
});

it('still grows right from text given no alignment', () => {
  const { grid, left, right, cellLeft, cellRight } = editNumber('x');
  expect(left).toBe(cellLeft);
  expect(right).toBeGreaterThan(cellRight);
  grid.destroy();
});
