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

async function mount() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  await flush();
  return { wb, id, grid };
}

// A block merged around the selection by anything but the grid itself (someone editing the workbook with
// you, the assistant, a script, an undo) left the active cell under the block: C3 selected, B2:D4 merged,
// and an entry typed then went into C3, a covered cell, kept but never shown. The selection now takes in
// the merged cell, its active cell the block's anchor, as a selection made over it would.
describe('a block merged around the selection', () => {
  it('takes the selection to the merged cell, so an entry typed goes where it shows', async () => {
    const { wb, id, grid } = await mount();
    grid.selectByName('C3');
    wb.mergeCells(id, { r1: 1, c1: 1, r2: 3, c2: 3 });
    await flush();
    expect(grid.active).toEqual({ r: 1, c: 1 });
    expect(grid.range).toEqual({ r1: 1, c1: 1, r2: 3, c2: 3 });
    key(grid.viewport, 'x');
    key(grid.el.querySelector('.grid-editor'), 'Enter');
    expect(wb.getValue(id, 1, 1)).toBe('x');
    expect(wb.getValue(id, 2, 2)).toBe(null);
    grid.destroy();
  });

  it('grows a range it cuts through to take in the block', async () => {
    const { wb, id, grid } = await mount();
    grid.selectByName('A1:B2');
    wb.mergeCells(id, { r1: 1, c1: 1, r2: 2, c2: 2 });
    await flush();
    expect(grid.range).toEqual({ r1: 0, c1: 0, r2: 2, c2: 2 });
    expect(grid.active).toEqual({ r: 0, c: 0 });
    grid.destroy();
  });

  it('leaves the selection of a block that is unmerged as it was', async () => {
    const { wb, id, grid } = await mount();
    wb.mergeCells(id, { r1: 1, c1: 1, r2: 3, c2: 3 });
    grid.selectByName('B2:D4');
    wb.unmergeCells(id, { r1: 1, c1: 1, r2: 3, c2: 3 });
    await flush();
    expect(grid.range).toEqual({ r1: 1, c1: 1, r2: 3, c2: 3 });
    grid.destroy();
  });
});
