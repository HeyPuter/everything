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
const key = (target, k, init = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

/** C5:C7 merged with its first row, 5, hidden; the merged cell selected (at its hidden anchor, C5). */
async function mount(fill) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  fill?.(wb, id);
  wb.mergeCells(id, { r1: 4, c1: 2, r2: 6, c2: 2 });
  wb.setHidden(id, 'row', [4], true);
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  await flush();
  grid.selectByName('C6');
  expect(grid.active).toEqual({ r: 4, c: 2 });
  return { wb, id, grid };
}

// A merged cell whose first row is hidden is selected at its anchor, in that hidden row. A step sideways out
// of it kept that row, and so landed on a hidden cell (B5 or D5): nothing on screen was selected, and an
// entry typed went into a cell nobody could see. The step now goes from the merged cell's first row on show.
describe('a step sideways out of a merged cell whose first row is hidden', () => {
  it('lands on the first row of the block on show, with the arrows', async () => {
    const { grid } = await mount();
    key(grid.viewport, 'ArrowLeft');
    expect(grid.active).toEqual({ r: 5, c: 1 });
    grid.selectByName('C6');
    key(grid.viewport, 'ArrowRight');
    expect(grid.active).toEqual({ r: 5, c: 3 });
    grid.destroy();
  });

  it('and with Ctrl+arrow', async () => {
    const { grid } = await mount((wb, id) => { wb.setInput(id, 4, 6, 'hidden row'); wb.setInput(id, 5, 6, 'shown row'); });
    key(grid.viewport, 'ArrowRight', { ctrlKey: true, metaKey: true });
    expect(grid.active).toEqual({ r: 5, c: 6 });
    grid.destroy();
  });

  it('still steps down out of it from its last row', async () => {
    const { grid } = await mount();
    key(grid.viewport, 'ArrowDown');
    expect(grid.active).toEqual({ r: 7, c: 2 });
    grid.destroy();
  });
});
