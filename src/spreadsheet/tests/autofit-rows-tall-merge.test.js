// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook, DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT } from '../src/core/workbook.js';

const ROW = DEFAULT_ROW_HEIGHT;
import { wrapLines, heightForLines, rowPad } from '../src/core/textfit.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

/** The height the grid gives `text` wrapped in one default-width column, measured as the test canvas does. */
const needed = (text) => heightForLines(wrapLines(text, DEFAULT_COL_WIDTH - 8, (t) => t.length * 7).length, 13, 0, rowPad(ROW, 13));

function mount() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.mergeCells(id, { r1: 0, c1: 0, r2: 2, c2: 0 });
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { wrap: true });
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  vi.runOnlyPendingTimers();
  return { wb, id, grid, heights: () => [0, 1, 2].map((r) => wb.rowHeight(id, r)) };
}

// Wrapped text in a cell merged down three rows was measured as if it had only the first row to
// show in, so that row grew to the whole text's height on top of the two rows below it.
it('leaves the rows of a merge alone while the text fits their heights together', () => {
  const { wb, id, grid, heights } = mount();
  const text = 'one two three four five six';
  expect(needed(text)).toBeGreaterThan(ROW); // more than the first row alone holds
  expect(needed(text)).toBeLessThanOrEqual(heights().reduce((a, b) => a + b, 0));
  wb.setInput(id, 0, 0, text);
  grid.autoFitRows(0, 2);
  expect(heights()).toEqual([ROW, ROW, ROW]);
  grid.destroy();
});

it('grows a merge only by what its text still lacks, in its first row, and gives it back when the text shrinks', () => {
  const { wb, id, grid, heights } = mount();
  const text = 'word '.repeat(40).trim();
  const need = needed(text);
  expect(need).toBeGreaterThan(3 * ROW);
  wb.setInput(id, 0, 0, text);
  grid.autoFitRows(0, 2);
  expect(heights()).toEqual([Math.round(need - 2 * ROW), ROW, ROW]);
  // Fitting the rows again to the same text changes nothing more.
  grid.autoFitRows(0, 2);
  expect(heights()).toEqual([Math.round(need - 2 * ROW), ROW, ROW]);
  // An entry that fits gives the room back on the next fit of the rows.
  wb.setInput(id, 0, 0, 'short');
  grid.autoFitRows(0, 2, { force: true });
  expect(heights()).toEqual([ROW, ROW, ROW]);
  grid.destroy();
});

it('fits the row of a merge across columns, which has only its own height, to the text at the merged width', () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.mergeCells(id, { r1: 0, c1: 0, r2: 0, c2: 2 });
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { wrap: true });
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  vi.runOnlyPendingTimers();
  const text = 'word '.repeat(60).trim();
  wb.setInput(id, 0, 0, text);
  grid.autoFitRows(0, 0);
  expect(wb.rowHeight(id, 0)).toBe(Math.round(heightForLines(wrapLines(text, DEFAULT_COL_WIDTH * 3 - 8, (t) => t.length * 7).length, 13, 0, rowPad(ROW, 13))));
  grid.destroy();
});
