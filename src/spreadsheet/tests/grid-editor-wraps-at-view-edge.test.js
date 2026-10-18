// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// An entry typed into a cell runs on to the right as far as the window's edge. There the box stopped
// growing but kept its text on one line, so the text scrolled inside it and the start of a long entry,
// or of a long formula, went out of sight at the box's left edge. The box now wraps the text there and
// grows downward, as Excel's does; an entry that fits stays on its line, where the cell draws it.
const grids = [];
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: t => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function ({ left, top }) { this.scrollLeft = left; this.scrollTop = top; };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
});
afterEach(() => { for (const grid of grids.splice(0)) grid.destroy(); document.body.replaceChildren(); });

function mount() {
  const wb = new Workbook({ sheets: [{ name: 'Data', rows: 100, cols: 20 }] });
  const grid = createGrid({ wb, sheetId: wb.activeSheetId, announce() {} });
  grids.push(grid);
  document.body.append(grid.el);
  const editor = grid.el.querySelector('.grid-editor');
  return { wb, grid, editor };
}

it('wraps a long entry at the edge of the window and grows the box downward', () => {
  const { grid, editor } = mount();
  const rowHeight = grid.cellRect(4, 5).height;
  grid.selectByName('F5');
  grid.beginEdit({ text: 'This entry is far too long to fit between its cell and the right edge of the window', mode: 'type' });
  expect(editor.classList.contains('wrap')).toBe(true);
  // As wide as the room to the window's edge, and taller than the row, so every line shows.
  const left = grid.cellRect(4, 5).left - grid.viewport.getBoundingClientRect().left;
  expect(parseFloat(editor.style.width)).toBeLessThanOrEqual(800 - left);
  expect(parseFloat(editor.style.height)).toBeGreaterThan(rowHeight);
});

it('wraps a long formula there too', () => {
  const { grid, editor } = mount();
  grid.selectByName('F5');
  grid.beginEdit({ text: `=SUM(${Array.from({ length: 40 }, (_, i) => i + 1).join(',')})`, mode: 'type' });
  expect(editor.classList.contains('wrap')).toBe(true);
});

it('keeps an entry that fits on its own line', () => {
  const { grid, editor } = mount();
  grid.selectByName('B5');
  grid.beginEdit({ text: 'A label that runs past its cell', mode: 'type' });
  expect(editor.classList.contains('wrap')).toBe(false);
  expect(parseFloat(editor.style.height)).toBe(grid.cellRect(4, 1).height);
  expect(parseFloat(editor.style.width)).toBeGreaterThan(grid.cellRect(4, 1).width);
});
