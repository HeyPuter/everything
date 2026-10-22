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

async function mount(setup = () => {}) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  setup(wb, id);
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  await flush();
  return grid;
}

/** The active cell after each of `n` presses of Ctrl+. (⌘. on a Mac). */
function presses(grid, n) {
  const seen = [];
  for (let i = 0; i < n; i++) {
    grid.viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
    seen.push({ ...grid.selection.active });
  }
  return seen;
}

// Ctrl+. steps the active cell to the next corner of the selection, as in Excel. A one-column or one-row
// selection has its four corners in two places; the step to the next of the four could land where the
// active cell already was, so A1:A3 never left A1 and A1:C1 stuck at C1.
describe('Ctrl+. moves the active cell to another corner', () => {
  it('goes between the ends of a one-column selection', async () => {
    const grid = await mount();
    grid.selectByName('A1:A3');
    expect(presses(grid, 3)).toEqual([{ r: 2, c: 0 }, { r: 0, c: 0 }, { r: 2, c: 0 }]);
    expect(grid.ranges).toEqual([{ r1: 0, c1: 0, r2: 2, c2: 0 }]);
    grid.destroy();
  });

  it('goes between the ends of a one-row selection', async () => {
    const grid = await mount();
    grid.selectByName('A1:C1');
    expect(presses(grid, 3)).toEqual([{ r: 0, c: 2 }, { r: 0, c: 0 }, { r: 0, c: 2 }]);
    grid.destroy();
  });

  it('still goes round all four corners of a block', async () => {
    const grid = await mount();
    grid.selectByName('B2:D4');
    expect(presses(grid, 4)).toEqual([{ r: 1, c: 3 }, { r: 3, c: 3 }, { r: 3, c: 1 }, { r: 1, c: 1 }]);
    grid.destroy();
  });

  it('counts a merged cell on a corner as standing there, and goes on to the next corner', async () => {
    const grid = await mount((wb, id) => wb.mergeCells(id, { r1: 1, c1: 1, r2: 2, c2: 2 }));
    // A1:B2 grows to A1:C3 over the merged B2:C3, whose anchor B2 stands for the bottom-right corner.
    grid.selectByName('A1:B2');
    expect(presses(grid, 4)).toEqual([{ r: 0, c: 2 }, { r: 1, c: 1 }, { r: 2, c: 0 }, { r: 0, c: 0 }]);
    grid.destroy();
  });
});
