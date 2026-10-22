// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';
import { AxisOffsets } from '../src/ui/axis-offsets.js';

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

const flush = () => new Promise((r) => setTimeout(r, 5));
const press = (grid, key, init = {}) => grid.viewport.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));

/** Rows 11 to the end of the sheet hidden, as a tidy form or dashboard hides them; rows 3 to 5 hidden too. */
async function mount() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 0, 0, 'top');
  wb.setInput(id, 9, 0, 'last');
  const rows = [];
  for (let r = 10; r < 1048576; r++) rows.push(r);
  wb.setHidden(id, 'row', [2, 3, 4], true);
  wb.setHidden(id, 'row', rows, true);
  wb.ensureSize(id, 1048576, 0);
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  await flush();
  // Count the hidden rows looked at, which is what the walk cost.
  const hidden = wb.sheet(id).hiddenRows;
  const has = hidden.has.bind(hidden);
  grid.lookups = 0;
  hidden.has = (r) => { grid.lookups++; return has(r); };
  return grid;
}

// An arrow, Enter, Tab, PageDown or Ctrl+arrow from the last row shown above rows hidden to the sheet's end
// walked the million hidden rows one at a time to find there was nowhere to go: some 80ms a press, every press
// at the foot of the form. A run of hidden lines is now passed in one leap, as the layout knows it.
describe('keys at the last row shown above rows hidden to the end of the sheet', () => {
  it('stay on the last row shown, at once', async () => {
    const grid = await mount();
    for (const [key, init] of [['ArrowDown', {}], ['ArrowDown', { shiftKey: true }], ['Enter', {}], ['PageDown', {}], ['ArrowDown', { ctrlKey: true, metaKey: true }]]) {
      grid.selectByName('A10');
      grid.lookups = 0;
      press(grid, key, init);
      expect(grid.selection.active).toEqual({ r: 9, c: 0 });
      expect(grid.ranges).toEqual([{ r1: 9, c1: 0, r2: 9, c2: 0 }]);
      expect(grid.lookups).toBeLessThan(1000);
    }
    grid.destroy();
  });

  it('still step over a short run of hidden rows, either way', async () => {
    const grid = await mount();
    grid.selectByName('A2');
    press(grid, 'ArrowDown');
    expect(grid.selection.active).toEqual({ r: 5, c: 0 });
    press(grid, 'ArrowUp');
    expect(grid.selection.active).toEqual({ r: 1, c: 0 });
    press(grid, 'ArrowDown', { ctrlKey: true, metaKey: true });
    expect(grid.selection.active).toEqual({ r: 9, c: 0 });
    press(grid, 'ArrowUp', { ctrlKey: true, metaKey: true });
    expect(grid.selection.active).toEqual({ r: 0, c: 0 });
    grid.destroy();
  });
});

describe('AxisOffsets.blankRun', () => {
  it('gives the run of lines of no size holding a line', () => {
    const offsets = new AxisOffsets().build(100, 20, [[7, 40]], [new Set([3, 4, 5]), new Set([90, 91])]);
    expect(offsets.blankRun(4)).toEqual([3, 5]);
    expect(offsets.blankRun(90)).toEqual([90, 91]);
    expect(offsets.blankRun(6)).toBe(null);
    expect(offsets.blankRun(7)).toBe(null);
    expect(offsets.blankRun(100)).toBe(null);
  });
});
