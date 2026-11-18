// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook, DEFAULT_ROW_HEIGHT, DEFAULT_COL_WIDTH, MAX_ROWS, MAX_COLS } from '../src/core/workbook.js';
import * as S from '../src/core/selection.js';

const VIEWPORT_W = 800, VIEWPORT_H = 400;
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return VIEWPORT_W; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return VIEWPORT_H; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); });

const ROW = Math.round(DEFAULT_ROW_HEIGHT), COL = Math.round(DEFAULT_COL_WIDTH); // a default line on screen at 100%
/** The scroll that brings the last of `n` default rows (columns) to the viewport's far edge. */
const bottom = (n) => n * ROW - VIEWPORT_H;
const right = (n) => n * COL - VIEWPORT_W;
/** A frame, as after an event. */
const frame = () => vi.advanceTimersByTimeAsync(5);
/** Long enough for anything put off to have happened. */
const settle = () => vi.advanceTimersByTimeAsync(400);

/** A viewport whose scrollTo lands (jsdom has no layout), and whose scroll events are raised by hand, as a browser would after each. */
async function mount(prepare) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  prepare?.(wb, id);
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  const pos = { left: 0, top: 0 };
  Object.defineProperty(grid.viewport, 'scrollLeft', { configurable: true, get: () => pos.left, set: (v) => { pos.left = v; } });
  Object.defineProperty(grid.viewport, 'scrollTop', { configurable: true, get: () => pos.top, set: (v) => { pos.top = v; } });
  grid.viewport.scrollTo = ({ left, top }) => { pos.left = left; pos.top = top; };
  await frame();
  /** The user drags the scrollbar's thumb to a place: the browser moves the viewport and says so, and the scroll goes on while the thumb is held. */
  const dragTo = (top, left = pos.left) => { pos.top = top; pos.left = left; grid.viewport.dispatchEvent(new Event('scroll')); };
  const release = () => grid.viewport.dispatchEvent(new Event('scrollend'));
  /** The user scrolls to a place, and the scroll ends there. */
  const scrollTo = (top, left) => { dragTo(top, left); release(); };
  /** The wheel turns, and the browser scrolls for it; the scroll is not over yet. */
  const wheelTo = (top, left = pos.left) => { grid.viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: top - pos.top })); dragTo(top, left); };
  const size = () => ({ rows: wb.sheet(id).rows, cols: wb.sheet(id).cols });
  return { wb, id, grid, pos, scrollTo, dragTo, release, wheelTo, size };
}

// Scrolling toward the bottom or the right of a sheet adds rows and columns to it, like an endless page. They
// stayed for good: every sheet kept all the rows its user had ever scrolled past, a saved file kept them too,
// and only deleting them took them off again.
describe('rows and columns added by scrolling', () => {
  it('go again when the view scrolls back, nothing having been put in them', async () => {
    const { grid, scrollTo, size } = await mount();
    scrollTo(bottom(100));
    scrollTo(bottom(200));
    scrollTo(bottom(300));
    expect(size()).toEqual({ rows: 400, cols: 26 });
    scrollTo(0);
    await frame();
    expect(size()).toEqual({ rows: 100, cols: 26 });
    grid.destroy();
  });

  it('go as the wheel scrolls back over them, without waiting for the scroll to end', async () => {
    const { grid, wheelTo, size } = await mount();
    wheelTo(bottom(100));
    wheelTo(bottom(200));
    wheelTo(bottom(300));
    expect(size().rows).toBe(400);
    wheelTo(bottom(250));
    await frame();
    expect(size().rows).toBe(300);
    wheelTo(bottom(150));
    await frame();
    expect(size().rows).toBe(200);
    wheelTo(0);
    await frame();
    expect(size().rows).toBe(100);
    grid.destroy();
  });

  it('go as a key takes the selection, and the view with it, back over them', async () => {
    const { wb, id, grid, size } = await mount();
    wb.setInput(id, 0, 0, 'top');
    grid.setSelection(S.single(950, 0));
    grid.viewport.dispatchEvent(new Event('scroll')); // the grid's own scroll, bringing the cell into view
    await frame();
    expect(size().rows).toBeGreaterThan(950);
    grid.setSelection(S.single(0, 0));
    grid.viewport.dispatchEvent(new Event('scroll'));
    await frame();
    expect(size().rows).toBe(100);
    grid.destroy();
  });

  it('stay while the scrollbar\'s thumb is held, however long it rests, and go when it is let go', async () => {
    const { grid, scrollTo, dragTo, release, size } = await mount();
    scrollTo(bottom(100));
    scrollTo(bottom(200));
    scrollTo(bottom(300));
    // The thumb maps the pointer to the sheet's length: a sheet shortened under it would jump at the next move.
    dragTo(bottom(150));
    await settle();
    await settle();
    expect(size().rows).toBe(400);
    dragTo(0);
    await settle();
    expect(size().rows).toBe(400);
    release();
    await settle();
    expect(size().rows).toBe(100);
    grid.destroy();
  });

  it('go one step at a time as the view passes back over them', async () => {
    const { grid, scrollTo, size } = await mount();
    scrollTo(bottom(100));
    scrollTo(bottom(200));
    scrollTo(bottom(300));
    scrollTo(bottom(250));
    await settle();
    expect(size().rows).toBe(300);
    scrollTo(bottom(150));
    await settle();
    expect(size().rows).toBe(200);
    grid.destroy();
  });

  it('stay while the view rests at the end they were added for', async () => {
    const { grid, scrollTo, size } = await mount();
    scrollTo(bottom(100));
    expect(size().rows).toBe(200);
    await settle();
    expect(size().rows).toBe(200);
    // And the sheet does not grow again for it: only a scroll toward the new end does.
    scrollTo(bottom(100) - ROW);
    await settle();
    expect(size().rows).toBe(200);
    grid.destroy();
  });

  it('go for columns as for rows', async () => {
    const { grid, scrollTo, size } = await mount();
    scrollTo(0, right(26));
    scrollTo(0, right(36));
    expect(size()).toEqual({ rows: 100, cols: 46 });
    scrollTo(0, 0);
    await settle();
    expect(size()).toEqual({ rows: 100, cols: 26 });
    grid.destroy();
  });

  it('stay up to what was typed in them, with the blank rows a file opens with after it', async () => {
    const { wb, id, grid, scrollTo, size } = await mount();
    scrollTo(bottom(100));
    scrollTo(bottom(200));
    scrollTo(bottom(300));
    wb.setInput(id, 250, 0, 'kept');
    scrollTo(0);
    await settle();
    expect(size().rows).toBe(271);
    expect(wb.getCell(id, 250, 0).v).toBe('kept');
    // Cleared again, the rows are as empty as they were.
    wb.setInput(id, 250, 0, '');
    scrollTo(ROW);
    await settle();
    expect(size().rows).toBe(100);
    grid.destroy();
  });

  it('stay under a cell that is only formatted, a note, a merged cell and a chart', async () => {
    for (const put of [
      (wb, id) => wb.applyStyle(id, { r1: 180, c1: 2, r2: 180, c2: 2 }, { bold: true }),
      (wb, id) => wb.setNote(id, 180, 2, 'note'),
      (wb, id) => wb.mergeCells(id, { r1: 179, c1: 2, r2: 180, c2: 3 }),
      (wb, id) => wb.addChart(id, { type: 'line', range: { r1: 0, c1: 0, r2: 4, c2: 1 }, anchor: { r: 170, c: 2 }, dx: 0, dy: 0, w: 300, h: 10 * DEFAULT_ROW_HEIGHT + 5 }),
    ]) {
      const { wb, id, grid, scrollTo, size } = await mount();
      scrollTo(bottom(100));
      scrollTo(bottom(200));
      put(wb, id);
      scrollTo(0);
      await settle();
      expect(size().rows).toBe(181);
      grid.destroy();
    }
  });

  it('stay while the selection is in them, and go once it has left', async () => {
    const { grid, scrollTo, size } = await mount();
    scrollTo(bottom(100));
    scrollTo(bottom(200));
    grid.setSelection(S.single(250, 0), { scroll: false });
    scrollTo(0);
    await settle();
    expect(size().rows).toBe(300);
    expect(grid.active).toEqual({ r: 250, c: 0 });
    grid.setSelection(S.single(0, 0), { scroll: false });
    await settle();
    expect(size().rows).toBe(100);
    grid.destroy();
  });

  it('go from a sheet that was saved with them', async () => {
    let saved;
    const { wb, id, grid, size } = await mount((book, sheet) => {
      book.ensureSize(sheet, 3000, 90);
      book.setInput(sheet, 9, 1, 'data');
      saved = { rows: book.sheet(sheet).rows, cols: book.sheet(sheet).cols };
    });
    expect(saved).toEqual({ rows: 3000, cols: 90 });
    // Shown, the sheet is as long as its contents and the view need.
    expect(size()).toEqual({ rows: 100, cols: 26 });
    // Nothing of the document changed for it: no step to undo but the entry, and nothing to save again.
    expect(wb.undoLabels()).toHaveLength(1);
    expect(wb.getCell(id, 9, 1).v).toBe('data');
    grid.destroy();
  });

  it('leave a whole column selected as it was', async () => {
    const { grid, scrollTo, size } = await mount();
    scrollTo(bottom(100));
    scrollTo(bottom(200));
    grid.setSelection(S.selectCols(1, 1, { rows: MAX_ROWS, cols: MAX_COLS }), { scroll: false });
    const before = grid.range;
    expect(before).toEqual({ r1: 0, c1: 1, r2: MAX_ROWS - 1, c2: 1 });
    scrollTo(0);
    await settle();
    expect(size().rows).toBe(100);
    expect(grid.range).toEqual(before);
    grid.destroy();
  });
});

describe('Workbook.trimSize', () => {
  it('shrinks to what the view needs, never below a new sheet\'s size or what the sheet holds, and never grows', () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    wb.ensureSize(id, 500, 60);
    expect(wb.trimSize(id, 240, 31)).toBe(true);
    expect(wb.sheet(id)).toMatchObject({ rows: 240, cols: 31 });
    expect(wb.trimSize(id, 900, 90)).toBe(false);
    expect(wb.trimSize(id, 0, 28)).toBe(true); // 0 leaves an axis alone
    expect(wb.sheet(id)).toMatchObject({ rows: 240, cols: 28 });
    wb.setInput(id, 150, 3, 'x');
    expect(wb.heldSize(id)).toEqual({ rows: 171, cols: 26 });
    expect(wb.trimSize(id, 1, 1)).toBe(true);
    expect(wb.sheet(id)).toMatchObject({ rows: 171, cols: 26 });
    expect(wb.trimSize(id, 1, 1)).toBe(false);
  });

  it('is no edit: nothing to undo, nothing to save, and recorded as the growth it takes back', () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    wb.ensureSize(id, 500, 60);
    wb.dirty = false;
    const before = wb.version;
    expect(wb.trimSize(id, 1, 1)).toBe(true);
    expect(wb.dirty).toBe(false);
    expect(wb.undoLabels()).toHaveLength(0);
    expect(wb.changesSince(before)).toEqual([{ version: wb.version, type: 'layout', sheetId: id, box: null, formula: false, grow: true }]);
  });

  it('keeps a table and an outline group on the sheet, and lets a resized column and rows hidden to the grid\'s end wait beyond its end', () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    wb.ensureSize(id, 900, 60);
    wb.setColWidth(id, 40, 240);
    wb.setHidden(id, 'row', Array.from({ length: 1048576 - 700 }, (_, i) => 700 + i), true);
    wb.addRule?.(id, { type: 'cell', op: '>', value: 1, range: { r1: 0, c1: 0, r2: 1048575, c2: 0 }, style: { bold: true } });
    expect(wb.heldSize(id)).toEqual({ rows: 100, cols: 26 });
    wb.groupLines(id, 'row', 300, 320);
    expect(wb.heldSize(id).rows).toBe(321);
    wb.setInput(id, 399, 0, 'h');
    wb.setInput(id, 400, 0, 1);
    wb.addTable(id, { r1: 399, c1: 0, r2: 500, c2: 0 });
    expect(wb.heldSize(id).rows).toBe(501);
    wb.trimSize(id, 1, 1);
    expect(wb.sheet(id)).toMatchObject({ rows: 501, cols: 26 });
    expect(wb.sheet(id).colWidths.get(40)).toBe(240);
    expect(wb.isHidden(id, 'row', 800)).toBe(true);
  });

  it('keeps the frozen panes and the first line that scrolls under them', () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    wb.ensureSize(id, 900, 60);
    wb.sheet(id).frozenRows = 3;
    wb.sheet(id).frozenOrigin = { r: 200, c: 0 };
    expect(wb.heldSize(id)).toEqual({ rows: 204, cols: 26 });
  });
});
