// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
const pointer = (target, type, init) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'mouse', ...init }));

/** A block of data filling A1:B100, the 100 rows a new sheet lays out, selected with Ctrl+A. */
async function mount() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  for (let r = 0; r < 100; r++) { wb.setInput(id, r, 0, `a${r + 1}`); wb.setInput(id, r, 1, `b${r + 1}`); }
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  await flush();
  grid.selectAll();
  await flush();
  expect(grid.range).toEqual({ r1: 0, c1: 0, r2: 99, c2: 1 });
  expect(wb.sheet(id).rows).toBe(100); // the block ends on the last row laid out so far
  return { wb, id, grid, clip: grid.el.querySelector('.grid-colhead-clip') };
}

// A block of cells reaching the last row the sheet had laid out so far was taken for whole columns:
// its column letters were marked as selected whole, dragging one of them moved the columns, and
// resizing one resized every column of the block.
describe('a block of cells down to the last laid-out row', () => {
  it('marks its column letters as part of a selection, not as whole columns selected', async () => {
    const { grid, clip } = await mount();
    const head = clip.querySelector('.hcell[data-c="0"]');
    expect(head.classList.contains('hl')).toBe(true);
    expect(head.classList.contains('sel')).toBe(false);
    grid.destroy();
  });

  it('selects columns when a column letter is dragged, instead of moving the columns', async () => {
    const { wb, id, grid, clip } = await mount();
    pointer(clip.querySelector('.hcell[data-c="0"]'), 'pointerdown', { clientX: 30, clientY: 10 });
    pointer(clip, 'pointermove', { clientX: 300, clientY: 10 });
    pointer(clip, 'pointerup', { clientX: 300, clientY: 10 });
    await flush();
    expect(wb.getValue(id, 0, 0)).toBe('a1');
    expect(wb.getValue(id, 0, 1)).toBe('b1');
    expect(grid.range.r1).toBe(0);
    expect(grid.range.c1).toBe(0);
    expect(grid.range.r2).toBe(1048575);
    expect(grid.range.c2).toBeGreaterThan(1);
    grid.destroy();
  });

  it('resizes only the column whose edge is dragged', async () => {
    const { wb, id, grid, clip } = await mount();
    const before = wb.colWidth(id, 1);
    const edge = clip.querySelector('.col-resizer[data-c="0"]');
    pointer(edge, 'pointerdown', { clientX: 100, clientY: 10 });
    pointer(clip, 'pointermove', { clientX: 140, clientY: 10 });
    pointer(clip, 'pointerup', { clientX: 140, clientY: 10 });
    expect(wb.colWidth(id, 0)).toBe(before + 40);
    expect(wb.colWidth(id, 1)).toBe(before);
    grid.destroy();
  });

  it('still treats whole columns picked by their letters as whole', async () => {
    const { wb, id, grid, clip } = await mount();
    grid.selectByName('A:B');
    await flush();
    expect(clip.querySelector('.hcell[data-c="0"]').classList.contains('sel')).toBe(true);
    const before = wb.colWidth(id, 1);
    pointer(clip.querySelector('.col-resizer[data-c="0"]'), 'pointerdown', { clientX: 100, clientY: 10 });
    pointer(clip, 'pointermove', { clientX: 140, clientY: 10 });
    pointer(clip, 'pointerup', { clientX: 140, clientY: 10 });
    expect(wb.colWidth(id, 1)).toBe(before + 40);
    grid.destroy();
  });
});
