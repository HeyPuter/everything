// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { createOptionButton } from '../src/ui/option-button.js';
import { Workbook, DEFAULT_ROW_HEIGHT } from '../src/core/workbook.js';

// The Paste Options (Auto Fill Options) button at the corner of what was just pasted went when the
// corner scrolled out of the window, but not when it scrolled under frozen rows: it stayed, drawn over
// the frozen cells.

const ROW = Math.round(DEFAULT_ROW_HEIGHT);
let scroll = 0;
beforeEach(() => {
  scroll = 0;
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

describe('the options button and frozen rows', () => {
  it('goes when the pasted block\'s corner scrolls under the frozen rows', async () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    wb.setFrozen(id, 3, 0);
    const grid = createGrid({ wb, sheetId: id });
    document.body.replaceChildren(grid.el);
    const vp = grid.viewport;
    vp.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 });
    grid.el.getBoundingClientRect = vp.getBoundingClientRect;
    Object.defineProperty(vp, 'scrollTop', { configurable: true, get: () => scroll, set: (v) => { scroll = v; } });
    await flush();
    const button = createOptionButton({ grid, host: grid.el });
    button.show({ kind: 'paste', sheetId: id, range: { r1: 4, c1: 1, r2: 5, c2: 2 }, mark: 1, items: [], checked: null, onPick() {} });
    expect(button.visible).toBe(true);
    scroll = 2 * ROW; // the corner (row 6's bottom) is now just below the frozen rows
    button.place();
    expect(button.visible).toBe(true);
    scroll = 3 * ROW; // and now under them
    button.place();
    expect(button.visible).toBe(false);
    button.destroy();
    grid.destroy();
  });
});
