// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';
import { AxisOffsets, MAX_CANVAS_EXTENT } from '../src/ui/axis-offsets.js';
import * as S from '../src/core/selection.js';

// Every sheet is the whole grid, A1:XFD1048576. The canvas holds the rows and columns reached so far,
// and shows a very long sheet through a window of it, but the keys and the Name Box reach all of it, fast.

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));
const key = (t, k, init = {}) => t.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
const mod = { ctrlKey: true, metaKey: true };
const LAST_ROW = 1048575;
const LAST_COL = 16383;

async function mount(prep = () => {}, gridOpts = {}) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  prep(wb, id);
  const grid = createGrid({ wb, sheetId: id, announce() {}, ...gridOpts });
  document.body.replaceChildren(grid.el);
  const pos = { left: 0, top: 0 };
  Object.defineProperty(grid.viewport, 'scrollLeft', { configurable: true, get: () => pos.left, set: (v) => { pos.left = v; } });
  Object.defineProperty(grid.viewport, 'scrollTop', { configurable: true, get: () => pos.top, set: (v) => { pos.top = v; } });
  grid.viewport.scrollTo = ({ left, top }) => { pos.left = left; pos.top = top; };
  await flush();
  const canvas = grid.el.querySelector('.grid-canvas');
  /** Where a cell is drawn in the viewport, from its row's and cell's own nodes. */
  const drawn = (r, c) => {
    const node = grid.el.querySelector(`#gc-${r}-${c}`);
    if (!node) return null;
    const row = node.parentNode;
    const y = Number(/translateY\((-?[\d.]+)px\)/.exec(row.style.transform)?.[1]);
    return { top: y - pos.top, left: grid.cellRect(r, c).left };
  };
  return { wb, id, grid, pos, canvas, drawn };
}

describe('the full grid', () => {
  it('runs Ctrl+Arrow to row 1,048,576 and column XFD in empty territory, and back with Ctrl+Up and Ctrl+Left', async () => {
    const { wb, id, grid, pos, canvas } = await mount();
    key(grid.viewport, 'ArrowDown', mod);
    expect(grid.active).toEqual({ r: LAST_ROW, c: 0 });
    key(grid.viewport, 'ArrowRight', mod);
    expect(grid.active).toEqual({ r: LAST_ROW, c: LAST_COL });
    expect(wb.sheet(id).rows).toBe(LAST_ROW + 1);
    expect(wb.sheet(id).cols).toBe(LAST_COL + 1);
    await flush();
    // The canvas never grows past what a browser lays out; the last cell is drawn in the viewport.
    expect(parseFloat(canvas.style.height)).toBeLessThanOrEqual(MAX_CANVAS_EXTENT);
    const box = grid.cellRect(LAST_ROW, LAST_COL);
    expect(box.width).toBeGreaterThan(0);
    expect(grid.el.querySelector(`#gc-${LAST_ROW}-${LAST_COL}`)).not.toBeNull();
    expect(grid.el.querySelector('.grid-rowhead .hcell:last-of-type')?.textContent).toBe('1048576');
    key(grid.viewport, 'ArrowUp', mod);
    key(grid.viewport, 'ArrowLeft', mod);
    expect(grid.active).toEqual({ r: 0, c: 0 });
    expect([pos.top, pos.left]).toEqual([0, 0]);
    grid.destroy();
  });

  it('stops at the data on the way, over hidden rows, and extends with Shift', async () => {
    const { wb, id, grid } = await mount((wb, id) => {
      wb.setInput(id, 500000, 0, 'far');
      wb.setInput(id, 500001, 0, 'farther');
      wb.setHidden(id, 'row', [LAST_ROW, LAST_ROW - 1], true);
    });
    key(grid.viewport, 'ArrowDown', mod);
    expect(grid.active).toEqual({ r: 500000, c: 0 });
    key(grid.viewport, 'ArrowDown', mod);
    expect(grid.active).toEqual({ r: 500001, c: 0 });
    key(grid.viewport, 'ArrowDown', mod);
    expect(grid.active).toEqual({ r: LAST_ROW - 2, c: 0 }); // the last shown row
    key(grid.viewport, 'ArrowUp', mod);
    expect(grid.active).toEqual({ r: 500001, c: 0 });
    grid.setSelection(S.single(0, 0));
    key(grid.viewport, 'ArrowDown', { ...mod, shiftKey: true });
    expect(grid.range).toEqual({ r1: 0, c1: 0, r2: 500000, c2: 0 });
    key(grid.viewport, 'End', mod);
    expect(grid.active).toEqual({ r: 500001, c: 0 }); // Ctrl+End: the last used cell
    key(grid.viewport, 'Home', mod);
    expect(grid.active).toEqual({ r: 0, c: 0 });
    expect(wb.sheet(id).rows).toBeGreaterThan(500001);
    grid.destroy();
  });

  it('goes to any cell up to XFD1048576 from the Name Box', async () => {
    const { wb, id, grid, drawn } = await mount();
    for (const [name, r, c] of [['K250000', 249999, 10], ['XFD1048576', LAST_ROW, LAST_COL], ['A1', 0, 0], ['C900000', 899999, 2]]) {
      expect(grid.selectByName(name)).toBe(true);
      await flush();
      expect(grid.active).toEqual({ r, c });
      const at = drawn(r, c);
      expect(at).not.toBeNull();
      expect(at.top).toBeGreaterThanOrEqual(0);
      expect(at.top).toBeLessThan(400);
    }
    expect(grid.selectByName('XFE1')).toBe(false);
    expect(grid.selectByName('A1048577')).toBe(false);
    // As far as the cell gone to last, and the rows a move to the edge adds: the empty rows past it, reached on the way, were given back.
    expect(wb.sheet(id).rows).toBe(900000 + 100);
    grid.destroy();
  });

  it('selects whole columns, rows and the sheet as their full extent', async () => {
    const { grid } = await mount();
    grid.selectByName('C:D');
    expect(grid.range).toEqual({ r1: 0, c1: 2, r2: LAST_ROW, c2: 3 });
    grid.selectByName('5:6');
    expect(grid.range).toEqual({ r1: 4, c1: 0, r2: 5, c2: LAST_COL });
    grid.el.querySelector('.grid-corner').click();
    expect(grid.range).toEqual({ r1: 0, c1: 0, r2: LAST_ROW, c2: LAST_COL });
    key(grid.viewport, 'a', mod);
    expect(grid.range).toEqual({ r1: 0, c1: 0, r2: LAST_ROW, c2: LAST_COL });
    grid.destroy();
  });

  it('places far rows exactly, with custom heights and hidden rows before them, at any zoom', async () => {
    const { wb, id, grid } = await mount((wb, id) => {
      wb.ensureSize(id, LAST_ROW + 1, 26);
      wb.setRowHeight(id, 10, 60);
      wb.setRowHeight(id, 700000, 45);
      wb.setHidden(id, 'row', [20, 21, 22], true);
    });
    for (const zoom of [1, 0.5, 4]) {
      grid.setZoom(zoom);
      expect(grid.selectByName('A700001')).toBe(true);
      await flush();
      const s = wb.sheet(id);
      const row = Math.round(s.defaultRowHeight * zoom);
      // Rows 699,999 to 700,001 are drawn one after another with their own heights.
      const a = grid.cellRect(699999, 0), b = grid.cellRect(700000, 0), c = grid.cellRect(700001, 0);
      expect(b.top - a.top).toBe(row);
      expect(c.top - b.top).toBe(Math.round(45 * zoom));
      expect(b.height).toBe(Math.round(45 * zoom));
    }
    grid.destroy();
  });

  it('keeps frozen rows and columns in place while a far row is shown through the window', async () => {
    const { wb, id, grid, pos } = await mount((wb, id) => { wb.setInput(id, 0, 0, 'Head'); wb.setFrozen(id, 2, 1); });
    expect(grid.selectByName('C900000')).toBe(true);
    await flush();
    const s = wb.sheet(id);
    const h = Math.round(s.defaultRowHeight);
    // The frozen rows keep the canvas's first pixels; the far row sits just where the view shows it.
    // (cellRect is in viewport coordinates.)
    expect(grid.cellRect(0, 0).top).toBe(0);
    expect(grid.cellRect(1, 0).top).toBe(h);
    const far = grid.cellRect(899999, 2);
    expect(far.top).toBeGreaterThanOrEqual(2 * h);
    expect(far.top + far.height).toBeLessThanOrEqual(400);
    expect(pos.top).toBeLessThan(6_000_000);
    expect(grid.frozen).toEqual({ rows: 2, cols: 1 });
    expect(grid.el.querySelector('.frz-rows .cell')).not.toBeNull();
    grid.destroy();
  });

  it('moves the canvas window with the user\'s scroll, keeping what is on screen in place', async () => {
    const extent = 20000; // a small window, so a sheet of a thousand rows needs one
    // A value in its last row keeps the sheet that long: an empty end would be given back once the sheet is shown.
    const { wb, id, grid, pos, canvas } = await mount((wb, id) => { wb.ensureSize(id, 5000, 26); wb.setInput(id, 4999, 0, 'last'); }, { maxCanvasExtent: extent });
    const h = wb.sheet(id).defaultRowHeight;
    expect(parseFloat(canvas.style.height)).toBe(extent);
    // Scroll down by hand, a screen at a time, well past the first window.
    let lastTop = 0;
    for (let i = 0; i < 120; i++) {
      pos.top += 400;
      grid.viewport.dispatchEvent(new Event('scroll'));
      await flush();
      const top = grid.cellAtPoint(grid.viewport.getBoundingClientRect().left + 5, grid.viewport.getBoundingClientRect().top + 1).r;
      expect(top).toBeGreaterThanOrEqual(lastTop); // never jumps back
      lastTop = top;
      expect(pos.top).toBeLessThanOrEqual(extent - 400);
    }
    expect(lastTop).toBeGreaterThan(Math.floor(120 * 400 / Math.round(h)) - 5);
    expect(parseFloat(canvas.style.height)).toBeLessThanOrEqual(extent);
    grid.destroy();
  });
});

describe('the work a full-size sheet costs', () => {
  it('stays with the cells that exist: Ctrl+Arrow, the Name Box and a far draw never visit every row', async () => {
    const built = [];
    const build = AxisOffsets.prototype.build;
    vi.spyOn(AxisOffsets.prototype, 'build').mockImplementation(function (n, d, entries = []) { built.push(entries.length); return build.call(this, n, d, entries); });
    const { wb, id, grid } = await mount((wb, id) => {
      wb.setInput(id, 3, 0, 'a');
      wb.setInput(id, 800000, 0, 'b');
      wb.setRowHeight(id, 5, 40);
    });
    const getCell = vi.spyOn(wb, 'getCell');
    const spillAt = vi.spyOn(wb, 'spillAt');
    key(grid.viewport, 'ArrowDown', mod); // to the data at A4
    key(grid.viewport, 'ArrowDown', mod); // over 800,000 empty rows to A800001
    key(grid.viewport, 'ArrowDown', mod); // and on to the last row
    key(grid.viewport, 'ArrowRight', mod);
    grid.selectByName('K250000');
    await flush();
    expect(grid.active).toEqual({ r: 249999, c: 10 });
    // The sheet reached its last row on the way; back above the data, it ends after it again (with the blank rows kept after a value).
    expect(wb.sheet(id).rows).toBe(800001 + 20);
    // Thousands at most for a screenful of cells, never hundreds of thousands for the rows walked past.
    expect(getCell.mock.calls.length).toBeLessThan(5000);
    expect(spillAt.mock.calls.length).toBeLessThan(5000);
    // Laying out a million rows reads the lines that differ, not one entry per row.
    expect(Math.max(...built)).toBeLessThan(10);
    // Only a screenful (and a margin) of cells is drawn.
    expect(grid.el.querySelectorAll('.grid-cells .cell').length).toBeLessThan(1000);
    grid.destroy();
  });
});
