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
const inside = (p, rg) => p.r >= rg.r1 && p.r <= rg.r2 && p.c >= rg.c1 && p.c <= rg.c2;

async function mount() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  await flush();
  return grid;
}

// Enter and Tab move the active cell through a selection without changing it. Stretching the selection
// afterwards with Shift pivots on the corner it was begun from, and could leave the active cell outside
// it: C3, Shift+Up (C2:C3), Enter (to C2), Shift+Down left C3 selected and C2 active, outlined nowhere
// yet the cell typing went into. The active cell now goes back to the corner the selection stretches from.
describe('the active cell stays inside the selection', () => {
  it('Shift+arrow after Enter has walked the selection', async () => {
    const grid = await mount();
    grid.selectByName('C3');
    key(grid.viewport, 'ArrowUp', { shiftKey: true });
    key(grid.viewport, 'Enter');
    expect(grid.active).toEqual({ r: 1, c: 2 });
    key(grid.viewport, 'ArrowDown', { shiftKey: true });
    expect(grid.range).toEqual({ r1: 2, c1: 2, r2: 2, c2: 2 });
    expect(grid.active).toEqual({ r: 2, c: 2 });
    key(grid.viewport, 'x');
    expect(grid.editState).toMatchObject({ r: 2, c: 2 });
    grid.destroy();
  });

  it('Ctrl+Shift+arrow after Shift+Tab has walked the selection', async () => {
    const grid = await mount();
    grid.selectByName('C3');
    key(grid.viewport, 'ArrowUp', { shiftKey: true });
    key(grid.viewport, 'Tab', { shiftKey: true });
    key(grid.viewport, 'ArrowDown', { shiftKey: true, ctrlKey: true, metaKey: true });
    expect(inside(grid.active, grid.range)).toBe(true);
    grid.destroy();
  });

  it('keeps an active cell that is still inside, where it is', async () => {
    const grid = await mount();
    grid.selectByName('B2:D4');
    key(grid.viewport, 'Enter');
    expect(grid.active).toEqual({ r: 2, c: 1 });
    key(grid.viewport, 'ArrowDown', { shiftKey: true });
    expect(grid.range).toEqual({ r1: 1, c1: 1, r2: 4, c2: 3 });
    expect(grid.active).toEqual({ r: 2, c: 1 });
    grid.destroy();
  });
});
