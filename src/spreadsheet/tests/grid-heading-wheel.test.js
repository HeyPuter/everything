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

const wheel = (target, init) => {
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 20, clientY: 100, ...init });
  target.dispatchEvent(e);
  return e;
};

function setup() {
  const wb = new Workbook();
  const grid = createGrid({ wb, sheetId: wb.sheets[0].id });
  document.body.replaceChildren(grid.el);
  const scrolls = [];
  grid.viewport.scrollBy = (x, y) => scrolls.push([x, y]);
  return { grid, scrolls, rows: grid.el.querySelector('.grid-rowhead-clip'), cols: grid.el.querySelector('.grid-colhead-clip') };
}

// The headings do not scroll themselves: the wheel over the row numbers or the column letters did nothing, and a
// Ctrl+wheel (a trackpad's pinch) there zoomed the whole page instead of the sheet.
describe('the wheel over the row and column headings', () => {
  it('scrolls the sheet as it does over the cells', () => {
    const { grid, scrolls, rows, cols } = setup();
    expect(wheel(rows, { deltaY: 120 }).defaultPrevented).toBe(true);
    wheel(cols, { deltaY: -60, deltaX: 30 });
    wheel(rows, { deltaY: 3, deltaMode: 1 }); // a mouse that counts in lines
    wheel(cols, { deltaY: 100, shiftKey: true }); // Shift turns the wheel sideways
    expect(scrolls).toEqual([[0, 120], [30, -60], [0, 60], [100, 0]]);
    grid.destroy();
  });

  it('zooms the sheet with Ctrl or the command key, and leaves the page alone', () => {
    const { grid, scrolls, rows, cols } = setup();
    expect(wheel(cols, { deltaY: -50, ctrlKey: true }).defaultPrevented).toBe(true);
    expect(grid.zoom).toBe(1.1);
    wheel(rows, { deltaY: 50, ctrlKey: true, metaKey: true });
    expect(grid.zoom).toBe(1);
    expect(scrolls).toEqual([]);
    grid.destroy();
  });
});
