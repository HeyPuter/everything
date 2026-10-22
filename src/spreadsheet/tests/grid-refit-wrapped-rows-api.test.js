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

const flush = () => new Promise((r) => setTimeout(r, 5));
const WORDS = Array.from({ length: 12 }, (_, i) => `word${i % 10}`).join(' ');
const ROWS = 30;

/** Thirty rows of twelve wrapped words in column A, each fitted to the 100px column (105px, six lines). */
async function mount() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  for (let r = 0; r < ROWS; r++) wb.setInput(id, r, 0, WORDS);
  wb.applyStyle(id, { r1: 0, c1: 0, r2: ROWS - 1, c2: 0 }, { wrap: true });
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  grid.autoFitRows(0, ROWS - 1);
  expect(wb.rowHeight(id, 0)).toBe(105);
  wb.clearHistory();
  // Every value the refit reads to measure a row, counted only while the transaction is open, so
  // the frame's own rendering is left out.
  let reads = 0;
  const getValue = wb.getValue.bind(wb);
  wb.getValue = (...args) => { reads++; return getValue(...args); };
  return { wb, id, grid, reads: () => reads };
}

// A resize made outside the grid can now fit its wrapped rows itself, inside its own transaction,
// through grid.refitWrappedRows: the dialogs and the widths paste call it so the heights join their
// undo step. The grid also fits them when the layout change reaches it, so the two must not both do
// the work — the explicit call records the columns as fitted for the widths they now hold.
describe('grid.refitWrappedRows, called from the transaction that set the widths', () => {
  it('does the work once, as the grid doing it alone does, and lands as one undo step', async () => {
    // The grid's own answer to the layout change: one pass over the wrapped rows.
    const alone = await mount();
    alone.wb.transaction('Resize columns', () => alone.wb.setColWidth(alone.id, 0, 300));
    const onePass = alone.reads();
    await flush();
    expect(alone.wb.rowHeight(alone.id, 0)).toBe(37);
    expect(alone.wb.undoLabels()).toEqual(['Resize columns']);
    expect(onePass).toBe(ROWS); // one reading per wrapped row: the rows were really measured

    // The same resize, with the caller fitting the rows itself before the transaction closes.
    const asked = await mount();
    asked.wb.transaction('Resize columns', () => {
      const before = new Map([[0, asked.wb.colWidth(asked.id, 0)]]);
      asked.wb.setColWidth(asked.id, 0, 300);
      asked.grid.refitWrappedRows([0], before);
    });
    const withCall = asked.reads();
    await flush();
    expect(asked.wb.rowHeight(asked.id, 0)).toBe(37); // the same height
    expect(asked.wb.rowHeight(asked.id, ROWS - 1)).toBe(37);
    expect(withCall).toBe(onePass); // the same work, not twice over

    // Still one undo step, and one Ctrl/Cmd+Z puts the width and every height back together.
    expect(asked.wb.undoLabels()).toEqual(['Resize columns']);
    asked.wb.undo();
    await flush();
    expect({ height: asked.wb.rowHeight(asked.id, 0), width: asked.wb.colWidth(asked.id, 0) }).toEqual({ height: 105, width: 100 });
    expect(asked.wb.undoLabels()).toEqual([]);
  });

  it('fits several columns at once and leaves a row someone sized by hand alone', async () => {
    const { wb, id, grid } = await mount();
    wb.setRowHeight(id, 3, 60);
    wb.setInput(id, 5, 2, WORDS);
    wb.applyStyle(id, { r1: 5, c1: 2, r2: 5, c2: 2 }, { wrap: true });
    grid.autoFitRows(5, 5);
    wb.clearHistory();
    wb.transaction('Fit columns', () => {
      const before = new Map([[0, wb.colWidth(id, 0)], [2, wb.colWidth(id, 2)]]);
      wb.setColWidth(id, 0, 300);
      wb.setColWidth(id, 2, 300);
      grid.refitWrappedRows([0, 2], before);
    });
    await flush();
    expect(wb.rowHeight(id, 0)).toBe(37);
    expect(wb.rowHeight(id, 5)).toBe(37);
    expect(wb.rowHeight(id, 3)).toBe(60); // sized by hand: left where it was
    expect(wb.undoLabels()).toEqual(['Fit columns']);
  });

  it('does nothing when asked for no columns, or on a grid whose sheet is gone', async () => {
    const { wb, id, grid } = await mount();
    grid.refitWrappedRows([]);
    grid.refitWrappedRows(null);
    expect(wb.rowHeight(id, 0)).toBe(105);
    expect(wb.undoLabels()).toEqual([]);
  });
});
