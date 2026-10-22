// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// The box an entry is typed in grew to the right of its cell whatever the cell's alignment: in a cell aligned
// right the entry was typed over the cells after it, then drawn, once entered, over the cells before it. The box
// now grows the way the entry will run, as Excel's does: left from a right-aligned cell (and from Hebrew or
// Arabic text given no alignment), both ways from a centred one, right from any other.
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

const TEXT = 'An entry far longer than its own cell'; // 37 letters, 259px

function edit(style, ref = 'E5', text = TEXT) {
  const wb = new Workbook({ sheets: [{ name: 'Data', rows: 100, cols: 20 }] });
  const id = wb.activeSheetId;
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.append(grid.el);
  grid.selectByName(ref);
  const { r, c } = grid.active;
  if (style) wb.applyStyle(id, { r1: r, c1: c, r2: r, c2: c }, style);
  grid.beginEdit({ text, mode: 'type' });
  const editor = grid.el.querySelector('.grid-editor');
  const cell = grid.cellRect(r, c);
  const left = parseFloat(editor.style.left), width = parseFloat(editor.style.width);
  // In canvas coordinates: the cell's own left edge is its column's offset.
  const cellLeft = cell.left + grid.viewport.scrollLeft;
  return { grid, left, right: left + width, width, cellLeft, cellRight: cellLeft + cell.width };
}

it('grows left from a cell aligned right, ending at the cell\'s right edge', () => {
  const { grid, left, right, width, cellLeft, cellRight } = edit({ align: 'right' });
  expect(width).toBeGreaterThan(cellRight - cellLeft);
  expect(right).toBe(cellRight);
  expect(left).toBeLessThan(cellLeft);
  grid.destroy();
});

it('grows both ways from a centred cell', () => {
  const { grid, left, right, cellLeft, cellRight } = edit({ align: 'center' });
  expect(cellLeft - left).toBeGreaterThan(0);
  expect(cellLeft - left).toBeCloseTo(right - cellRight, 5);
  grid.destroy();
});

it('grows left for right-to-left text given no alignment', () => {
  const { grid, right, cellRight, left, cellLeft } = edit(null, 'E5', 'שלום עולם, זו רשומה ארוכה מאוד מעבר לתא');
  expect(right).toBe(cellRight);
  expect(left).toBeLessThan(cellLeft);
  grid.destroy();
});

it('still grows right from a cell with no alignment', () => {
  const { grid, left, right, cellLeft, cellRight } = edit(null);
  expect(left).toBe(cellLeft);
  expect(right).toBeGreaterThan(cellRight);
  grid.destroy();
});

// Held to twice the room on its narrower side, a centred entry in column A, which has no room to its left, kept
// to the column's width and wrapped a word a line down the sheet. It grows on to the side that has room.
it('grows on to the right from a centred cell with no room on its left', () => {
  const { grid, left, right, width, cellLeft, cellRight } = edit({ align: 'center' }, 'A5');
  expect(left).toBe(cellLeft);
  expect(right).toBeGreaterThan(cellRight);
  expect(width).toBeGreaterThanOrEqual(TEXT.length * 7);
  expect(grid.el.querySelector('.grid-editor').classList.contains('wrap')).toBe(false);
  grid.destroy();
});

it('grows evenly from a centred cell a little way in, then on to the right', () => {
  const { grid, left, right, cellLeft, cellRight } = edit({ align: 'center' }, 'B5', `${TEXT}, and longer still`);
  expect(left).toBeLessThan(cellLeft);
  expect(left).toBeGreaterThanOrEqual(0); // as far as the sheet's first column, and no further
  expect(left).toBeLessThanOrEqual(1);
  expect(right - cellRight).toBeGreaterThan(cellLeft - left);
  grid.destroy();
});
