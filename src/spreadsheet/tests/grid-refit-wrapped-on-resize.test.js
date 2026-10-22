// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook, DEFAULT_ROW_HEIGHT } from '../src/core/workbook.js';
import { heightForLines } from '../src/core/textfit.js';

/** The height a row fitted to one line of 13px text takes (never less than the default row). */
const ONE_LINE = heightForLines(1, 13, DEFAULT_ROW_HEIGHT);

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  Element.prototype.releasePointerCapture = function releasePointerCapture() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));

/** A1 holds twelve words of wrapped text (each 5 characters, 35px, plus a 7px space) in a 100px column. */
async function mount(prepare) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 0, 0, Array.from({ length: 12 }, (_, i) => `word${i % 10}`).join(' '));
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { wrap: true });
  prepare?.(wb, id);
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  // A width set from outside the grid (a dialog, Fit columns to content) has its rows fitted once the change has passed.
  const resize = async (c, w) => { wb.setColWidth(id, c, w); await flush(); };
  return { wb, id, grid, resize };
}

// A wrapped row was fitted when its text was entered and never again: made narrower, the column
// clipped the lines that no longer fit; made wider, it left a block of blank space under one line.
// Such rows are now fitted again whenever a wrapped column's width changes.
describe('rows of wrapped text when a column is resized', () => {
  it('are fitted to the new width again, narrower or wider', async () => {
    const { wb, id, grid, resize } = await mount();
    grid.autoFitRows(0, 0);
    expect(wb.rowHeight(id, 0)).toBe(105); // two words per 95px line: six lines
    wb.clearHistory();
    await resize(0, 300);
    expect(wb.rowHeight(id, 0)).toBe(37); // seven words per line: two lines
    await resize(0, 40);
    expect(wb.rowHeight(id, 0)).toBe(207); // one 35px word fits each 35px content line: twelve lines
    await resize(0, 800);
    expect(wb.rowHeight(id, 0)).toBe(ONE_LINE); // one line again
    // A one-row fit carries the step's own label. A width written with no transaction to join
    // announces itself before its own step is recorded, so each fit is recorded just before it.
    expect(wb.undoLabels()).toEqual(['Resize column', 'Resize row', 'Resize column', 'Resize row', 'Resize column', 'Resize row']);
  });

  it('are fitted even when the row was never fitted before, since nobody sized it', async () => {
    const { wb, id, resize } = await mount();
    expect(wb.rowHeight(id, 0)).toBe(DEFAULT_ROW_HEIGHT);
    await resize(0, 40);
    expect(wb.rowHeight(id, 0)).toBeGreaterThan(26);
  });

  it('leave a row someone sized by hand at that height', async () => {
    const { wb, id, resize } = await mount((wb, id) => { wb.setRowHeight(id, 0, 60); });
    await resize(0, 40);
    expect(wb.rowHeight(id, 0)).toBe(60);
    await resize(0, 500);
    expect(wb.rowHeight(id, 0)).toBe(60);
  });

  it('leave rows whose wrapped text is in other columns alone, and fit a merge across the resized column', async () => {
    const { wb, id, grid, resize } = await mount((wb, id) => {
      wb.setInput(id, 3, 2, 'a few words that wrap in a narrow column here');
      wb.applyStyle(id, { r1: 3, c1: 2, r2: 3, c2: 2 }, { wrap: true });
      wb.setInput(id, 6, 1, 'a merged title of several words across two columns that wraps');
      wb.applyStyle(id, { r1: 6, c1: 1, r2: 6, c2: 1 }, { wrap: true });
      wb.mergeCells(id, { r1: 6, c1: 1, r2: 6, c2: 2 });
    });
    grid.autoFitRows(3, 3);
    grid.autoFitRows(6, 6);
    const other = wb.rowHeight(id, 3);
    const merged = wb.rowHeight(id, 6);
    await resize(0, 40);
    expect(wb.rowHeight(id, 3)).toBe(other);
    expect(wb.rowHeight(id, 6)).toBe(merged);
    await resize(2, 400); // the merge B7:C7 spans column C
    expect(wb.rowHeight(id, 6)).toBeLessThan(merged);
    expect(wb.rowHeight(id, 3)).toBeLessThan(other);
  });

  // Fitted a moment after the transaction closed, the heights were an undo step of their own: the
  // first Ctrl/Cmd+Z put the row back and left the column wide, so a 300px column showed one line
  // of text with 68px of blank under it, and a second Ctrl/Cmd+Z was needed to undo the resize.
  it('join the resize they answer as one undo step, whoever asked for it', async () => {
    const { wb, id, grid } = await mount();
    grid.autoFitRows(0, 0);
    wb.clearHistory();
    // Fit columns to content, or a paste that carries column widths: several columns in one step.
    wb.transaction('Fit columns', () => { for (let c = 0; c < 5; c++) wb.setColWidth(id, c, 300); });
    await flush();
    expect(wb.rowHeight(id, 0)).toBe(37);
    expect(wb.undoLabels()).toEqual(['Fit columns']);
    wb.undo();
    await flush();
    expect(wb.rowHeight(id, 0)).toBe(105);
    expect(wb.colWidth(id, 0)).toBe(100);
    expect(wb.undoLabels()).toEqual([]);

    // Format → Column width on a single column takes the same route.
    wb.clearHistory();
    wb.transaction('Resize columns', () => wb.setColWidth(id, 0, 300));
    await flush();
    expect(wb.rowHeight(id, 0)).toBe(37);
    expect(wb.undoLabels()).toEqual(['Resize columns']);
    wb.undo();
    await flush();
    expect({ height: wb.rowHeight(id, 0), width: wb.colWidth(id, 0) }).toEqual({ height: 105, width: 100 });
    expect(wb.undoLabels()).toEqual([]);
  });

  it('happen with the resize itself, as one undo step, when a column edge is dragged', async () => {
    const { wb, id, grid } = await mount();
    grid.autoFitRows(0, 0);
    wb.clearHistory();
    const clip = grid.el.querySelector('.grid-colhead-clip');
    const resizer = clip.querySelector('.col-resizer[data-c="0"]');
    const pe = (target, type, x) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 10, pointerId: 1, button: 0, pointerType: 'mouse' }));
    pe(resizer, 'pointerdown', 148);
    pe(clip, 'pointermove', 348);
    pe(clip, 'pointerup', 348);
    expect(wb.sheet(id).colWidths.get(0)).toBe(300);
    expect(wb.rowHeight(id, 0)).toBe(37); // 12 words across two lines of 292px
    expect(wb.undoLabels()).toEqual(['Resize column']);
    wb.undo();
    expect(wb.sheet(id).colWidths.get(0)).toBeUndefined();
    expect(wb.rowHeight(id, 0)).toBe(105); // six lines, as fitted before
  });
});
