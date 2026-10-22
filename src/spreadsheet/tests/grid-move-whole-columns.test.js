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
// most 200,000 cells to move at once", as the move walked all 1,048,576 rows. Whole columns (or rows) now move whole,
// walking only the cells they hold, as Ctrl-dragging copies them.
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

// The first version of that move went only as far as the content, so a rule, validation or format covering the whole
// column was split: the part below the data stayed in the old column. They now go with the column whole, replacing
// the destination's, and come back whole with Undo.
it('carries the rules, validation and format covering a whole column with it', async () => {
  const { wb, id, grid, onInvalid } = await mount('B:B');
  const col = (c) => ({ r1: 0, c1: c, r2: 1048575, c2: c });
  wb.addRule(id, { range: col(1), type: 'gt', value: 10, style: { bg: '#ffeeaa' } });
  wb.addValidation(id, { range: col(1), type: 'list', source: 'a,b,c', strict: true });
  wb.applyStyle(id, col(1), { bold: true });
  wb.addRule(id, { range: col(3), type: 'lt', value: 0, style: { bg: '#000000' } });
  wb.applyStyle(id, col(3), { italic: true });
  wb.setInput(id, 1, 6, '=SUM(B:B)');
  wb.clearHistory();
  const before = wb.toJSON().sheets[0];
  const at = (c) => ({ clientX: (c + 1) * DEFAULT_COL_WIDTH - 1, clientY: 3.5 * DEFAULT_ROW_HEIGHT });
  pointer(grid.viewport, 'pointerdown', at(1));
  pointer(grid.viewport, 'pointermove', at(3));
  pointer(grid.viewport, 'pointerup', at(3));
  expect(onInvalid).not.toHaveBeenCalled();
  const sheet = wb.sheet(id);
  expect(sheet.rules.map((r) => [r.type, r.range])).toEqual([['gt', col(3)]]);
  expect(sheet.validations.map((v) => v.range)).toEqual([col(3)]);
  expect([...sheet.colStyles]).toEqual([[3, { bold: true }]]);
  expect(wb.styleAt(id, 5000, 3)).toEqual({ bold: true });
  expect(wb.getValue(id, 49, 3)).toBe(50);
  // A reference to the whole column follows it, as Excel's does.
  expect(wb.getCell(id, 1, 6).f).toBe('SUM(D:D)');
  expect(wb.getValue(id, 1, 6)).toBe(1275);
  // The sheet does not grow to the column's million rows to show it.
  expect(sheet.rows).toBe(before.rows);
  expect(wb.undoLabels()).toHaveLength(1);
  wb.undo();
  const after = wb.toJSON().sheets[0];
  expect(after.rules).toEqual(before.rules);
  expect(after.validations).toEqual(before.validations);
  expect(after.colStyles).toEqual(before.colStyles);
  expect(Object.keys(after.cells).sort()).toEqual(Object.keys(before.cells).sort());
  expect(wb.getValue(id, 49, 1)).toBe(50);
  expect(wb.getCell(id, 1, 6).f).toBe('SUM(B:B)');
  wb.redo();
  expect([...wb.sheet(id).colStyles]).toEqual([[3, { bold: true }]]);
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

it('carries the format of whole rows with them', async () => {
  const { wb, id, grid } = await mount('2:14', 14);
  for (let r = 1; r <= 13; r++) wb.sheet(id).rowStyles.set(r, { fg: '#ff0000' });
  wb.clearHistory();
  const at = (r) => ({ clientX: 2.5 * DEFAULT_COL_WIDTH, clientY: (r + 1) * Math.round(DEFAULT_ROW_HEIGHT) - 1 });
  pointer(grid.viewport, 'pointerdown', at(13));
  pointer(grid.viewport, 'pointermove', at(15));
  pointer(grid.viewport, 'pointerup', at(15));
  const sheet = wb.sheet(id);
  expect([...sheet.rowStyles.keys()].sort((a, b) => a - b)).toEqual(Array.from({ length: 13 }, (_, i) => i + 3));
  expect(wb.styleAt(id, 15, 9000)).toMatchObject({ fg: '#ff0000' });
  expect(wb.styleAt(id, 1, 9000)?.fg).toBeUndefined();
  wb.undo();
  expect([...sheet.rowStyles.keys()].sort((a, b) => a - b)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
  grid.destroy();
});
