// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook, DEFAULT_ROW_HEIGHT, DEFAULT_COL_WIDTH } from '../src/core/workbook.js';
import { isSingle } from '../src/core/selection.js';

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
const at = (r, c) => ({ clientX: (c + 0.5) * DEFAULT_COL_WIDTH, clientY: (r + 0.5) * DEFAULT_ROW_HEIGHT });
const key = (target, k, init = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

/** B2:C3 merged. */
async function mount() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.mergeCells(id, { r1: 1, c1: 1, r2: 2, c2: 2 });
  wb.setInput(id, 1, 1, 'Title');
  const spoken = [];
  const grid = createGrid({ wb, sheetId: id, announce: (m) => spoken.push(m) });
  document.body.replaceChildren(grid.el);
  await flush();
  return { grid, spoken };
}

const merged = { r1: 1, c1: 1, r2: 2, c2: 2 };

// A press on a large merged cell that slipped into another of its cells before the release, or a
// Shift+click on another of its cells, made a range of the merged block: the Name Box read B2:C3 rather
// than B2, a screen reader heard "B2:C3 selected", and the cell's link went unshown. In Excel the
// selection stays the one merged cell.
describe('a selection wholly inside a merged cell is that cell', () => {
  it('a drag across the cells of the merged block selects the merged cell', async () => {
    const { grid, spoken } = await mount();
    pointer(grid.viewport, 'pointerdown', at(1, 1));
    pointer(grid.viewport, 'pointermove', at(2, 2));
    pointer(grid.viewport, 'pointerup', at(2, 2));
    expect(isSingle(grid.selection)).toBe(true);
    expect(grid.selection.active).toEqual({ r: 1, c: 1 });
    expect(grid.range).toEqual(merged);
    expect(spoken.at(-1)).toBe('B2, Title, merged B2:C3');
    grid.destroy();
  });

  it('a Shift+click on another of its cells keeps the merged cell', async () => {
    const { grid } = await mount();
    pointer(grid.viewport, 'pointerdown', at(1, 1));
    pointer(grid.viewport, 'pointerup', at(1, 1));
    pointer(grid.viewport, 'pointerdown', { ...at(2, 2), shiftKey: true });
    pointer(grid.viewport, 'pointerup', { ...at(2, 2), shiftKey: true });
    expect(isSingle(grid.selection)).toBe(true);
    expect(grid.range).toEqual(merged);
    grid.destroy();
  });

  it('stretching out of the merged cell and back with Shift+arrows ends on the merged cell again', async () => {
    const { grid } = await mount();
    grid.selectByName('B2');
    key(grid.viewport, 'ArrowDown', { shiftKey: true });
    expect(grid.range).toEqual({ r1: 1, c1: 1, r2: 3, c2: 2 });
    key(grid.viewport, 'ArrowUp', { shiftKey: true });
    expect(isSingle(grid.selection)).toBe(true);
    expect(grid.range).toEqual(merged);
    grid.destroy();
  });

  it('a drag from the merged cell on to the cells beyond it still selects the range', async () => {
    const { grid } = await mount();
    pointer(grid.viewport, 'pointerdown', at(1, 1));
    pointer(grid.viewport, 'pointermove', at(2, 2));
    pointer(grid.viewport, 'pointermove', at(4, 3));
    pointer(grid.viewport, 'pointerup', at(4, 3));
    expect(grid.range).toEqual({ r1: 1, c1: 1, r2: 4, c2: 3 });
    expect(grid.selection.active).toEqual({ r: 1, c: 1 });
    grid.destroy();
  });
});
