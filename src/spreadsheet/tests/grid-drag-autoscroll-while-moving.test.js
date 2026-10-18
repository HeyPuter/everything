// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// Dragging a selection (or the fill handle) past the bottom of the grid scrolls the sheet. Every
// pointer move restarted the scrolling timer, so while the mouse kept moving below the grid — as it
// does when someone drags down — the timer never got to fire, and the sheet scrolled only once the
// mouse was held still.

let scrolls = 0;
beforeEach(() => {
  scrolls = 0;
  vi.useFakeTimers();
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.scrollBy = function scrollBy() { scrolls++; };
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  Element.prototype.releasePointerCapture = function releasePointerCapture() {};
  Element.prototype.hasPointerCapture = function hasPointerCapture() { return false; };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

describe('auto-scroll while dragging past the grid', () => {
  it('keeps scrolling while the pointer keeps moving below the grid', () => {
    const wb = new Workbook();
    const grid = createGrid({ wb, sheetId: wb.sheets[0].id, announce() {} });
    document.body.replaceChildren(grid.el);
    const vp = grid.viewport;
    vp.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 });
    vi.advanceTimersByTime(5);
    const pe = (type, x, y) => vp.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: 'mouse' }));
    pe('pointerdown', 150, 50);
    // Half a second of small moves below the grid, one every 16ms as a mouse reports them.
    for (let i = 0; i < 30; i++) { pe('pointermove', 150 + (i % 2), 420 + (i % 3)); vi.advanceTimersByTime(16); }
    expect(scrolls).toBeGreaterThanOrEqual(8);
    // Back inside the grid the scrolling stops.
    pe('pointermove', 150, 200);
    const before = scrolls;
    vi.advanceTimersByTime(500);
    expect(scrolls).toBe(before);
    pe('pointerup', 150, 200);
    grid.destroy();
  });
});
