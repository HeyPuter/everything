// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// Selected columns dragged by their headers move to where they are dropped. Dragged past the edge of
// the grid the sheet did not scroll, so columns could only be moved as far as the view reached; the
// drag now scrolls the sheet along its own axis, as selecting by the headers does.

let scrolls = [];
beforeEach(() => {
  scrolls = [];
  vi.useFakeTimers();
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.scrollBy = function scrollBy(x, y) { scrolls.push([x, y]); };
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  Element.prototype.releasePointerCapture = function releasePointerCapture() {};
  Element.prototype.hasPointerCapture = function hasPointerCapture() { return false; };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

describe('moving columns by their headers', () => {
  it('scrolls sideways when dragged past the right edge of the grid', () => {
    const wb = new Workbook();
    const grid = createGrid({ wb, sheetId: wb.sheets[0].id, announce() {} });
    document.body.replaceChildren(grid.el);
    grid.viewport.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 });
    vi.advanceTimersByTime(5);
    const head = () => grid.el.querySelector('.grid-colhead .hcell[data-c="2"]');
    const clip = grid.el.querySelector('.grid-colhead-clip');
    const pe = (target, type, x) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: -10, pointerId: 1, button: 0, pointerType: 'mouse' }));
    pe(head(), 'pointerdown', 250); pe(clip, 'pointerup', 250); // select column C
    vi.advanceTimersByTime(5);
    pe(head(), 'pointerdown', 250);
    for (let i = 0; i < 20; i++) { pe(clip, 'pointermove', 830 + i); vi.advanceTimersByTime(16); }
    expect(scrolls.length).toBeGreaterThan(3);
    expect(scrolls.every(([x, y]) => x > 0 && y === 0)).toBe(true);
    pe(clip, 'pointermove', 400);
    const before = scrolls.length;
    vi.advanceTimersByTime(300);
    expect(scrolls.length).toBe(before);
    pe(clip, 'pointerup', 400);
    grid.destroy();
  });
});
