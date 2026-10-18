// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// The viewport is 800x400 on screen, of which the client box is 785x385: a 15px scrollbar runs
// down its right side and along its bottom.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 785; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 385; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.scrollBy = function scrollBy() {};
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

function mount(opts = {}) {
  const wb = new Workbook();
  const grid = createGrid({ wb, sheetId: wb.sheets[0].id, ...opts });
  document.body.replaceChildren(grid.el);
  const viewport = grid.el.querySelector('.grid-viewport');
  viewport.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 });
  vi.runOnlyPendingTimers();
  return { grid, viewport };
}
const menuAt = (target, init) => target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, ...init }));
const pointer = (target, type, init) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'mouse', ...init }));

describe('a press on the grid\'s scrollbars', () => {
  it('selects no cell under the vertical scrollbar', () => {
    const { grid, viewport } = mount();
    pointer(viewport, 'pointerdown', { clientX: 792, clientY: 100 });
    pointer(viewport, 'pointerup', { clientX: 792, clientY: 100 });
    expect(grid.range).toEqual({ r1: 0, c1: 0, r2: 0, c2: 0 });
    grid.destroy();
  });

  it('selects no cell under the horizontal scrollbar', () => {
    const { grid, viewport } = mount();
    pointer(viewport, 'pointerdown', { clientX: 300, clientY: 392 });
    pointer(viewport, 'pointerup', { clientX: 300, clientY: 392 });
    expect(grid.range).toEqual({ r1: 0, c1: 0, r2: 0, c2: 0 });
    grid.destroy();
  });

  it('still selects the cell just inside the client box', () => {
    const { grid, viewport } = mount();
    pointer(viewport, 'pointerdown', { clientX: 300, clientY: 380 });
    pointer(viewport, 'pointerup', { clientX: 300, clientY: 380 });
    expect(grid.range.r1).toBeGreaterThan(0);
    grid.destroy();
  });

  // A right-click on a scrollbar selected the cell under it and opened the cell menu for it.
  it('opens no cell menu and selects nothing for a right-click on a scrollbar', () => {
    const onContextMenu = vi.fn();
    const { grid, viewport } = mount({ onContextMenu });
    menuAt(viewport, { clientX: 792, clientY: 100 });
    menuAt(viewport, { clientX: 300, clientY: 392 });
    expect(onContextMenu).not.toHaveBeenCalled();
    expect(grid.range).toEqual({ r1: 0, c1: 0, r2: 0, c2: 0 });
    menuAt(viewport, { clientX: 300, clientY: 100 });
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(grid.range.r1).toBeGreaterThan(0);
    grid.destroy();
  });
});
