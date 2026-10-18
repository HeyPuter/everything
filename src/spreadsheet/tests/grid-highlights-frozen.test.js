// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// Find's highlights (and Circle Invalid Data's circles) were drawn only for the cells in the
// scrolled window. A match in a frozen header row lost its highlight once the sheet scrolled down,
// even when it was the current match, though the frozen row itself stays on screen.

let scroll = { top: 0, left: 0 };
beforeEach(() => {
  scroll = { top: 0, left: 0 };
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

describe('find highlights in frozen panes', () => {
  it('keep a match in a frozen row highlighted when the sheet scrolls down', async () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    for (let r = 0; r < 300; r++) wb.setInput(id, r, 1, `apple ${r}`);
    wb.setFrozen(id, 1, 0);
    const grid = createGrid({ wb, sheetId: id });
    document.body.replaceChildren(grid.el);
    const viewport = grid.el.querySelector('.grid-viewport');
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => scroll.top, set: (v) => { scroll.top = v; } });
    await flush();
    grid.setHighlights([{ r: 0, c: 1 }, { r: 150, c: 1 }], 0);
    await flush();
    const marks = () => [...grid.el.querySelectorAll('.grid-canvas > .hl-layer .find-hl')];
    expect(marks()).toHaveLength(1); // row 151's match is out of view
    scroll.top = 150 * 20; // row 151 at the top of the scrolling pane, far below row 1's window
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    // The frozen row's match is still drawn (the frozen pane shows a copy of the layer), and it is the current one.
    expect(marks()).toHaveLength(2);
    expect(grid.el.querySelectorAll('.frz-rows .find-hl.current')).toHaveLength(1);
    grid.destroy();
  });
});
