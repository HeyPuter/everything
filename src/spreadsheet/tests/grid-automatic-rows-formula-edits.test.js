// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const measured = vi.hoisted(() => []);
vi.mock('../src/core/row-height.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, measureRows: (wb, sheetId, r1, r2, options = {}) => { measured.push(options.onlyRows ? options.onlyRows.size : r2 - r1 + 1); return mod.measureRows(wb, sheetId, r1, r2, options); } };
});

const { createGrid } = await import('../src/ui/grid.js');
const { Workbook } = await import('../src/core/workbook.js');

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

const ROWS = 2000;
/** A sheet as Excel saves a long list: every row sized automatically, a column of formulas beside the data. */
function setup() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const entries = [];
  for (let r = 0; r < ROWS; r++) entries.push({ r, c: 0, cell: { v: r } }, { r, c: 1, cell: { f: `A${r + 1}*2` } });
  // One formula's result is wrapped text, whose lines follow what it reads.
  entries.push({ r: 2, c: 2, cell: { f: 'REPT("word ",A1)', s: { wrap: true } } });
  wb.setCells(id, entries);
  for (let r = 0; r < ROWS; r++) wb.sheets[0].rowHeightModes.set(r, 'auto');
  wb.version++;
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  vi.runOnlyPendingTimers();
  measured.length = 0;
  return { wb, id, grid };
}
const rowsMeasured = () => measured.reduce((n, k) => n + k, 0);

// A long sheet from Excel has every row sized automatically, and each entry measured again every row holding a
// formula: on a list with a column of totals, every value typed waited on the whole sheet's rows being measured.
describe('rows sized automatically on a long sheet of formulas', () => {
  it('measure only the rows an entry can change', () => {
    const { wb, id, grid } = setup();
    wb.setInput(id, 500, 0, '7');
    vi.runOnlyPendingTimers();
    expect(rowsMeasured()).toBeLessThanOrEqual(2); // the row written, and the one whose wrapped result may move
    measured.length = 0;
    wb.setInput(id, 600, 1, '=A601*3');
    vi.runOnlyPendingTimers();
    expect(rowsMeasured()).toBeLessThanOrEqual(2);
    grid.destroy();
  });

  it('still fit a wrapped formula result to what it reads now', () => {
    const { wb, id, grid } = setup();
    const before = wb.rowHeight(id, 2);
    wb.setInput(id, 0, 0, '40'); // forty words wrapped in a 100px column
    vi.runOnlyPendingTimers();
    expect(wb.rowHeight(id, 2)).toBeGreaterThan(before);
    wb.setInput(id, 0, 0, '1');
    vi.runOnlyPendingTimers();
    expect(wb.rowHeight(id, 2)).toBe(before);
    // A formula turned to wrapped text later is followed too.
    wb.setCells(id, [{ r: 7, c: 3, cell: { f: 'REPT("word ",A9)', s: { wrap: true } } }]);
    vi.runOnlyPendingTimers();
    const fitted = wb.rowHeight(id, 7);
    wb.setInput(id, 8, 0, '60');
    vi.runOnlyPendingTimers();
    expect(wb.rowHeight(id, 7)).toBeGreaterThan(fitted);
    grid.destroy();
  });
});
