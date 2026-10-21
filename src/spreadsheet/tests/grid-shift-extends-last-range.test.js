// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
const key = (target, k, init = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
const pointer = (target, type, init) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'mouse', ...init }));
/** The middle of cell (r, c) on the screen: the viewport sits at the page's top-left in jsdom. */
const at = (r, c) => ({ clientX: (c + 0.5) * DEFAULT_COL_WIDTH, clientY: (r + 0.5) * DEFAULT_ROW_HEIGHT });

/** A2:A3 selected, then C2 added with Ctrl/Cmd+click. */
async function mount() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  await flush();
  grid.selectByName('A2:A3');
  pointer(grid.viewport, 'pointerdown', { ...at(1, 2), ctrlKey: true, metaKey: true });
  pointer(grid.viewport, 'pointerup', { ...at(1, 2), ctrlKey: true, metaKey: true });
  expect(grid.ranges).toEqual([{ r1: 1, c1: 0, r2: 2, c2: 0 }, { r1: 1, c1: 2, r2: 1, c2: 2 }]);
  return { grid };
}

// After Ctrl/Cmd+click had added a range, Shift+click or Shift+arrow, meant to stretch that range as in
// Excel, dropped every other range of the selection.
describe('Shift with ranges added by Ctrl/Cmd+click', () => {
  it('Shift+click stretches the last range and keeps the others', async () => {
    const { grid } = await mount();
    pointer(grid.viewport, 'pointerdown', { ...at(4, 3), shiftKey: true });
    pointer(grid.viewport, 'pointerup', { ...at(4, 3), shiftKey: true });
    expect(grid.ranges).toEqual([{ r1: 1, c1: 0, r2: 2, c2: 0 }, { r1: 1, c1: 2, r2: 4, c2: 3 }]);
    grid.destroy();
  });

  it('Shift+arrow and Ctrl+Shift+arrow stretch the last range and keep the others', async () => {
    const { grid } = await mount();
    key(grid.viewport, 'ArrowDown', { shiftKey: true });
    expect(grid.ranges).toEqual([{ r1: 1, c1: 0, r2: 2, c2: 0 }, { r1: 1, c1: 2, r2: 2, c2: 2 }]);
    key(grid.viewport, 'ArrowRight', { shiftKey: true, ctrlKey: true, metaKey: true });
    expect(grid.ranges[0]).toEqual({ r1: 1, c1: 0, r2: 2, c2: 0 });
    expect(grid.ranges).toHaveLength(2);
    expect(grid.ranges[1]).toMatchObject({ r1: 1, c1: 2, r2: 2 });
    grid.destroy();
  });

  it('Shift+click on a column letter stretches the last range of columns and keeps the others', async () => {
    const { grid } = await mount();
    grid.selectByName('B:B');
    const clip = grid.el.querySelector('.grid-colhead-clip');
    pointer(clip.querySelector('.hcell[data-c="3"]'), 'pointerdown', { clientX: 350, clientY: 10, ctrlKey: true, metaKey: true });
    pointer(clip, 'pointerup', { clientX: 350, clientY: 10, ctrlKey: true, metaKey: true });
    await flush();
    pointer(clip.querySelector('.hcell[data-c="5"]'), 'pointerdown', { clientX: 550, clientY: 10, shiftKey: true });
    pointer(clip, 'pointerup', { clientX: 550, clientY: 10, shiftKey: true });
    expect(grid.ranges.map(({ c1, c2 }) => [c1, c2])).toEqual([[1, 1], [3, 5]]);
    grid.destroy();
  });

  it('a plain click or arrow still goes back to one range', async () => {
    const { grid } = await mount();
    key(grid.viewport, 'ArrowDown');
    expect(grid.ranges).toEqual([{ r1: 2, c1: 2, r2: 2, c2: 2 }]);
    grid.destroy();
  });
});
