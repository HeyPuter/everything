// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook, DEFAULT_ROW_HEIGHT, DEFAULT_COL_WIDTH } from '../src/core/workbook.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  Element.prototype.releasePointerCapture = function releasePointerCapture() {};
  Element.prototype.hasPointerCapture = function hasPointerCapture() { return false; };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));
const pointer = (target, type, init) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'mouse', ...init }));

async function mount(name, rows = 50) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  for (let r = 0; r < rows; r++) wb.setInput(id, r, 1, String(r + 1));
  wb.setInput(id, 0, 6, '=SUM(B1:B50)');
  wb.setNote(id, 79, 1, 'below the data');
  wb.clearHistory();
  const onInvalid = vi.fn();
  const grid = createGrid({ wb, sheetId: id, onInvalid });
  document.body.replaceChildren(grid.el);
  await flush();
  grid.selectByName(name);
  return { wb, id, grid, onInvalid };
}

// Dragging whole columns by their border was refused: column B selected and dragged two columns along said "Select at
// most 200,000 cells to move at once", as the move walked all 1,048,576 rows. Whole columns (or rows) now move as far
// as the sheet's content goes, as Ctrl-dragging copies them and the header drag moves them.
it('moves a whole column dragged by its border', async () => {
  const { wb, id, grid, onInvalid } = await mount('B:B');
  const at = (c) => ({ clientX: (c + 1) * DEFAULT_COL_WIDTH - 1, clientY: 3.5 * DEFAULT_ROW_HEIGHT });
  pointer(grid.viewport, 'pointerdown', at(1));
  pointer(grid.viewport, 'pointermove', at(3));
  pointer(grid.viewport, 'pointerup', at(3));
  expect(onInvalid).not.toHaveBeenCalled();
  expect(wb.getValue(id, 49, 3)).toBe(50);
  expect(wb.getCell(id, 0, 1)).toBeFalsy();
  expect(wb.getNote(id, 79, 3)).toBe('below the data');
  expect(wb.getNote(id, 79, 1)).toBeFalsy();
  expect(wb.getCell(id, 0, 6).f).toBe('SUM(D1:D50)');
  expect(grid.range).toMatchObject({ r1: 0, c1: 3, c2: 3 });
  expect(grid.range.r2).toBeGreaterThan(1000000);
  expect(wb.undoLabels()).toHaveLength(1);
  wb.undo();
  expect(wb.getValue(id, 49, 1)).toBe(50);
  grid.destroy();
});

it('moves whole rows dragged by their border', async () => {
  const { wb, id, grid, onInvalid } = await mount('2:14', 14);
  const at = (r) => ({ clientX: 2.5 * DEFAULT_COL_WIDTH, clientY: (r + 1) * Math.round(DEFAULT_ROW_HEIGHT) - 1 });
  pointer(grid.viewport, 'pointerdown', at(13));
  pointer(grid.viewport, 'pointermove', at(15));
  pointer(grid.viewport, 'pointerup', at(15));
  expect(onInvalid).not.toHaveBeenCalled();
  expect(wb.getValue(id, 3, 1)).toBe(2);
  expect(wb.getValue(id, 15, 1)).toBe(14);
  expect(wb.getCell(id, 1, 1)).toBeFalsy();
  expect(wb.getCell(id, 0, 6).f).toBe('SUM(B1:B50)');
  grid.destroy();
});
