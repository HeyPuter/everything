// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook, DEFAULT_ROW_HEIGHT } from '../src/core/workbook.js';

// Scrolling down by a row built every cell in view again: zoomed out to 25% that was some eight
// thousand cells, about a hundred milliseconds a frame. The rows still in view are now kept as they
// were drawn and only the rows scrolling in are built; anything that may change a drawn row (an edit,
// other columns in view, a redraw asked for) still builds them all again.

const ROW = Math.round(DEFAULT_ROW_HEIGHT);
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

async function mount() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setCells(id, Array.from({ length: 200 }, (_, r) => ({ r, c: 0, cell: { v: r } })));
  wb.mergeCells(id, { r1: 30, c1: 2, r2: 31, c2: 3 });
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  const vp = grid.viewport;
  Object.defineProperty(vp, 'scrollTop', { configurable: true, get: () => scroll.top, set: (v) => { scroll.top = v; } });
  Object.defineProperty(vp, 'scrollLeft', { configurable: true, get: () => scroll.left, set: (v) => { scroll.left = v; } });
  await flush();
  const scrollBy = async (rows) => { scroll.top += rows * ROW; vp.dispatchEvent(new Event('scroll')); await flush(); };
  const row = (r) => grid.el.querySelector(`.grid-cells .grid-row[aria-rowindex="${r + 1}"]`);
  return { wb, id, grid, scrollBy, row };
}

describe('scrolling the grid', () => {
  it('keeps the rows still in view and builds the rows coming in', async () => {
    const { grid, scrollBy, row } = await mount();
    const kept = row(10);
    const bottom = grid.el.querySelector('.grid-cells .grid-row:last-child').getAttribute('aria-rowindex');
    await scrollBy(5);
    expect(row(10)).toBe(kept);
    expect(row(10).querySelector('#gc-10-0').textContent).toBe('10');
    // The rows that came in are drawn, in order down the sheet, and those that left are gone.
    const indexes = [...grid.el.querySelectorAll('.grid-cells .grid-row')].map((n) => Number(n.getAttribute('aria-rowindex')));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(Math.max(...indexes)).toBeGreaterThan(Number(bottom));
    expect(row(1)).toBeNull(); // row 1 stays: it holds the active cell A1
    expect(new Set(indexes).size).toBe(indexes.length);
    grid.destroy();
  });

  it('draws every row again after an edit, and keeps no row holding a merged block', async () => {
    const { wb, id, grid, scrollBy, row } = await mount();
    await scrollBy(20); // rows 21 to about 43 in view, the merged block at rows 31-32 among them
    const merged = row(30);
    const plain = row(25);
    await scrollBy(1);
    expect(row(25)).toBe(plain);
    // The merged block draws the part of its border in view, so its row is built each time.
    expect(row(30)).not.toBe(merged);
    wb.setInput(id, 25, 0, 'changed');
    await flush();
    expect(row(25)).not.toBe(plain);
    expect(row(25).querySelector('#gc-25-0').textContent).toBe('changed');
    const fresh = row(26);
    grid.redraw();
    await flush();
    expect(row(26)).not.toBe(fresh);
    grid.destroy();
  });
});
