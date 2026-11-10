// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));

/** Page Break Preview over the whole sheet in pages of `rows` by `cols`, as the editor hands it to the grid. */
function wholeSheetPages(rows, cols) {
  const rowBreaks = [], colBreaks = [], pages = [];
  for (let r = rows; r < 1048576; r += rows) rowBreaks.push({ at: r, manual: false });
  for (let c = cols; c < 16384; c += cols) colBreaks.push({ at: c, manual: false });
  let n = 0;
  for (let c = 0; c < 16384; c += cols) for (let r = 0; r < 1048576; r += rows) pages.push({ r1: r, r2: Math.min(1048575, r + rows - 1), c1: c, c2: Math.min(16383, c + cols - 1), n: ++n });
  return { area: { r1: 0, c1: 0, r2: 1048575, c2: 16383 }, pages, rowBreaks, colBreaks };
}

// A sheet with something in XFD1 and in A1048576 prints as hundreds of thousands of pages. Page Break Preview drew a
// box for every one of them, in one call, on every frame: the call overflowed the stack ("Maximum call stack size
// exceeded") and the view was left broken. Only the pages and the lines over the cells in view are drawn now.
it('Page Break Preview over a sheet of 480,000 pages draws the pages in view', async () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.ensureSize(id, 1048576, 16384);
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  const view = wholeSheetPages(46, 9);
  expect(view.pages.length).toBeGreaterThan(400000);
  expect(() => grid.setPageView(view)).not.toThrow();
  await flush();
  const boxes = [...grid.el.querySelectorAll('.page-box')].map((b) => b.textContent);
  expect(boxes).toEqual(['Page 1', 'Page 22797']);
  const lines = [...grid.el.querySelectorAll('.page-break-line')].map((l) => `${l.dataset.axis}${l.dataset.at}`);
  expect(lines).toEqual(['col9']);

  // A page break dragged and let go where it was goes back to its place, though nothing in view has changed.
  const line = grid.el.querySelector('.page-break-line');
  const before = line.style.transform;
  const vp = grid.viewport;
  line.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'mouse', clientX: 576, clientY: 100 }));
  vp.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'mouse', clientX: 700, clientY: 100 }));
  expect(line.style.transform).not.toBe(before); // the line follows the pointer while it is dragged
  vp.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'mouse', clientX: 576, clientY: 100 }));
  await flush();
  const after = grid.el.querySelector('.page-break-line');
  expect(after.style.transform).toBe(before);
  expect(after.classList.contains('dragging')).toBe(false);
  grid.destroy();
});
