// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook, DEFAULT_ROW_HEIGHT } from '../src/core/workbook.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.scrollBy = function scrollBy() {};
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  Element.prototype.releasePointerCapture = function releasePointerCapture() {};
  Element.prototype.hasPointerCapture = function hasPointerCapture() { return false; };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));
const ROW = Math.round(DEFAULT_ROW_HEIGHT); // a default row on screen at 100%
const LAST_ROW = 1048575; // 0-based

/** A grid on an 800×400 viewport at the screen's corner: columns are 100px wide, rows ROW px tall. */
async function mount(prepare) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  prepare?.(wb, id);
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  const vp = grid.viewport;
  vp.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 });
  await flush();
  /** A mouse double-click as the browser sends it: two presses and releases, each a click, then the dblclick. */
  const doubleClick = async (x, y) => {
    const pe = (type) => vp.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: 'mouse' }));
    const me = (type, detail) => vp.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, detail }));
    pe('pointerdown'); pe('pointerup'); me('click', 1);
    await flush();
    pe('pointerdown'); pe('pointerup'); me('click', 2); me('dblclick', 2);
    await flush();
  };
  return { wb, id, grid, vp, doubleClick };
}

// Issue #237: the first press of a double-click near a gridline selected the cell on one side of
// it, and the dblclick then found that cell's own edge under the pointer and jumped as if the
// selection's border had been double-clicked: just above B3's top line went to B1048576, just
// below it to B1. About half of every cell lies within reach of one of its edges.
describe('a double-click near a gridline', () => {
  it('selects the cell above the line instead of jumping to the last row', async () => {
    const { grid, doubleClick } = await mount();
    await doubleClick(150, 2 * ROW - 2); // in B2, 2px above the B2/B3 line; A1 is selected
    expect(grid.range).toEqual({ r1: 1, c1: 1, r2: 1, c2: 1 });
  });

  it('selects the cell below the line instead of jumping to the first row', async () => {
    const { grid, doubleClick } = await mount();
    await doubleClick(150, 2 * ROW + 2); // in B3, 2px below the B2/B3 line
    expect(grid.range).toEqual({ r1: 2, c1: 1, r2: 2, c2: 1 });
  });

  it('selects the cell beside a column line instead of jumping along the row', async () => {
    const { grid, doubleClick } = await mount((wb, id) => { for (let c = 0; c < 6; c++) wb.setInput(id, 4, c, c); });
    await doubleClick(198, 4 * ROW + ROW / 2); // in B5, 2px left of the B/C line, in a row of data
    expect(grid.range).toEqual({ r1: 4, c1: 1, r2: 4, c2: 1 });
  });
});

describe('a double-click on the selection border', () => {
  it('still jumps to the edge of the data that way when both presses land on it', async () => {
    const { grid, doubleClick } = await mount((wb, id) => { for (let r = 2; r <= 9; r++) wb.setInput(id, r, 1, r); });
    grid.setRanges([{ r1: 2, c1: 1, r2: 2, c2: 1 }]); // B3, the top of a column of data down to B10
    await doubleClick(150, 3 * ROW - 1); // on B3's bottom border
    expect(grid.range).toEqual({ r1: 9, c1: 1, r2: 9, c2: 1 });
  });

  it('jumps up from the top border on an empty sheet', async () => {
    const { grid, doubleClick } = await mount();
    grid.setRanges([{ r1: 5, c1: 1, r2: 5, c2: 1 }]); // B6
    await doubleClick(150, 5 * ROW + 1);
    expect(grid.range).toEqual({ r1: 0, c1: 1, r2: 0, c2: 1 });
  });

  it('jumps down to the last row from the bottom border on an empty sheet', async () => {
    const { grid, doubleClick } = await mount();
    grid.setRanges([{ r1: 5, c1: 1, r2: 5, c2: 1 }]);
    await doubleClick(150, 6 * ROW - 1);
    expect(grid.range).toEqual({ r1: LAST_ROW, c1: 1, r2: LAST_ROW, c2: 1 });
  });
});
