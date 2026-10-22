// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook, DEFAULT_ROW_HEIGHT } from '../src/core/workbook.js';
import * as S from '../src/core/selection.js';
import { heightForLines } from '../src/core/textfit.js';

/** The height a row fitted to one line of 13px text takes (never less than the default row). */
const ONE_LINE = heightForLines(1, 13, DEFAULT_ROW_HEIGHT);

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

function mount() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 9, c2: 0 }, { wrap: true });
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  vi.runOnlyPendingTimers();
  const type = (r, text) => { grid.setSelection(S.single(r, 0)); grid.beginEdit({ text, mode: 'type' }); grid.commitEdit(); };
  return { wb, id, grid, type };
}
const FOUR_LINES = 'aaaa bbbb cccc dddd eeee ffff gggg hhhh'; // two 4-letter words fit a 92px line at 7px a character

// Committing into a wrapped cell fitted the row to its text whatever height the row had, so a
// row someone had sized by hand snapped back to the text on the next entry.
describe('committing into a wrapped cell', () => {
  it('leaves a row height someone set alone unless the text needs more', () => {
    const { wb, id, type } = mount();
    wb.setRowHeight(id, 1, 60);
    type(1, 'short');
    expect(wb.rowHeight(id, 1)).toBe(60);
    type(1, FOUR_LINES);
    expect(wb.rowHeight(id, 1)).toBeGreaterThan(60);
    // Once grown for its text, shortening the text does not shrink it below what was set.
    type(1, 'short');
    expect(wb.rowHeight(id, 1)).toBeGreaterThan(60);
  });

  // The grid judges a row it has no memory of by its height: grown for its text, a hand-sized row
  // holds exactly what the text needs, like a fitted one, so the grow is remembered with the height
  // that was set as its floor, and that memory holds through undo and redo of the entry.
  it('still treats a grown hand-sized row as someone\'s through undo and redo, and a column resize leaves it', async () => {
    const { wb, id, grid, type } = mount();
    wb.setRowHeight(id, 1, 60);
    type(1, FOUR_LINES);
    expect(wb.rowHeight(id, 1)).toBe(71);
    wb.undo();
    expect(wb.rowHeight(id, 1)).toBe(60);
    wb.redo();
    expect(wb.rowHeight(id, 1)).toBe(71);
    type(1, 'short');
    expect(wb.rowHeight(id, 1)).toBe(71);
    // A fitted row would be refitted for the wider column; this one is left as it is.
    type(2, FOUR_LINES);
    wb.setColWidth(id, 0, 300);
    await Promise.resolve(); // the refit runs once the change has passed
    expect(wb.rowHeight(id, 2)).toBe(ONE_LINE); // the eight words fit one 292px line
    expect(wb.rowHeight(id, 1)).toBe(71);
    grid.destroy();
  });

  it('keeps fitting a row the grid sized itself, shrinking it again for shorter text', () => {
    const { wb, id, type } = mount();
    type(2, FOUR_LINES);
    const tall = wb.rowHeight(id, 2);
    expect(tall).toBeGreaterThan(ONE_LINE);
    type(2, 'short');
    expect(wb.rowHeight(id, 2)).toBe(ONE_LINE);
    // A height set afterwards is someone's choice again.
    type(2, FOUR_LINES);
    wb.setRowHeight(id, 2, 100);
    type(2, 'short');
    expect(wb.rowHeight(id, 2)).toBe(100);
  });

  it('keeps a set height when Alt+Enter turns wrapping on', () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    wb.setRowHeight(id, 3, 80);
    const grid = createGrid({ wb, sheetId: id });
    document.body.replaceChildren(grid.el);
    vi.runOnlyPendingTimers();
    grid.setSelection(S.single(3, 0));
    grid.beginEdit({ text: 'one\ntwo', mode: 'type' });
    grid.commitEdit();
    expect(wb.getCell(id, 3, 0).s.wrap).toBe(true);
    expect(wb.rowHeight(id, 3)).toBe(80);
  });
});
