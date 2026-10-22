// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

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
const key = (grid, k, init = {}) => grid.viewport.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

async function mount() {
  const wb = new Workbook();
  const grid = createGrid({ wb, sheetId: wb.sheets[0].id });
  document.body.replaceChildren(grid.el);
  await flush();
  return grid;
}

// Add to Selection (Shift+F8) keeps what is selected while the arrows take the cursor to where the next range
// begins, and Shift+arrow (or F8) then stretches that range, as in Excel. Each arrow kept the cell it left,
// so moving three cells along selected all three, and Shift+arrow moved on and kept cells too instead of
// stretching: no range could be built from the keyboard.
describe('Add to Selection', () => {
  it('moves the cursor on without keeping the cells it passes, and Shift+arrow stretches a new range there', async () => {
    const grid = await mount();
    grid.selectByName('A1:B2');
    key(grid, 'F8', { shiftKey: true });
    expect(grid.keyMode).toBe('add');
    key(grid, 'ArrowRight');
    key(grid, 'ArrowRight');
    key(grid, 'ArrowRight');
    expect(grid.ranges).toEqual([{ r1: 0, c1: 0, r2: 1, c2: 1 }, { r1: 0, c1: 3, r2: 0, c2: 3 }]);
    key(grid, 'ArrowDown', { shiftKey: true });
    key(grid, 'ArrowRight', { shiftKey: true });
    expect(grid.ranges).toEqual([{ r1: 0, c1: 0, r2: 1, c2: 1 }, { r1: 0, c1: 3, r2: 1, c2: 4 }]);
    // Moving on keeps the range just stretched.
    key(grid, 'ArrowDown');
    key(grid, 'ArrowDown');
    expect(grid.ranges).toEqual([{ r1: 0, c1: 0, r2: 1, c2: 1 }, { r1: 0, c1: 3, r2: 1, c2: 4 }, { r1: 2, c1: 3, r2: 2, c2: 3 }]);
    grid.destroy();
  });

  it('keeps a lone cell selected before the mode began', async () => {
    const grid = await mount();
    grid.selectByName('B2');
    key(grid, 'F8', { shiftKey: true });
    key(grid, 'ArrowDown');
    key(grid, 'ArrowDown');
    expect(grid.ranges).toEqual([{ r1: 1, c1: 1, r2: 1, c2: 1 }, { r1: 3, c1: 1, r2: 3, c2: 1 }]);
    grid.destroy();
  });
});
