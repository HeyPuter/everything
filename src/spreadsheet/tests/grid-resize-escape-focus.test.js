// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook, DEFAULT_ROW_HEIGHT } from '../src/core/workbook.js';

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
const pe = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: 'mouse' }));
const key = (target, k) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

/** The grid beside a focused button, as when the name box or a toolbar button had the focus. */
async function mount() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  const button = document.createElement('button');
  document.body.replaceChildren(grid.el, button);
  grid.el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 848, bottom: 426, width: 848, height: 426 });
  await flush();
  button.focus();
  expect(document.activeElement).toBe(button);
  return { wb, id, grid, guide: grid.el.querySelector('.resize-guide') };
}

// Escape gives up a drag through the viewport's keydown, and a fill, move or reorder press focuses
// the viewport first; a resize press did not, so with the focus in the name box or on a toolbar
// button Escape reached nothing and the column was resized on release anyway.
describe('Escape during a header resize drag', () => {
  it('cancels a column resize whatever had the focus before the press', async () => {
    const { wb, id, grid, guide } = await mount();
    const clip = grid.el.querySelector('.grid-colhead-clip');
    pe(clip.querySelector('.col-resizer[data-c="0"]'), 'pointerdown', 148, 10);
    expect(document.activeElement).toBe(grid.viewport);
    pe(clip, 'pointermove', 348, 10);
    expect(guide.hidden).toBe(false);
    expect(grid.el.querySelector('.resize-feedback').textContent).toBe('Width: 300 px');
    key(document.activeElement, 'Escape');
    expect(guide.hidden).toBe(true);
    expect(grid.el.querySelector('.resize-feedback').hidden).toBe(true);
    pe(clip, 'pointerup', 348, 10);
    expect(wb.sheet(id).colWidths.has(0)).toBe(false);
    expect(wb.undoLabels()).toEqual([]);
    grid.destroy();
  });

  it('cancels a row resize the same way, and a release without Escape still resizes', async () => {
    const { wb, id, grid } = await mount();
    const clip = grid.el.querySelector('.grid-rowhead-clip');
    pe(clip.querySelector('.row-resizer[data-r="0"]'), 'pointerdown', 20, 25);
    expect(document.activeElement).toBe(grid.viewport);
    pe(clip, 'pointermove', 20, 65);
    key(document.activeElement, 'Escape');
    pe(clip, 'pointerup', 20, 65);
    expect(wb.rowHeight(id, 0)).toBe(DEFAULT_ROW_HEIGHT);
    pe(clip.querySelector('.row-resizer[data-r="0"]'), 'pointerdown', 20, 25);
    pe(clip, 'pointermove', 20, 65);
    pe(clip, 'pointerup', 20, 65);
    expect(wb.rowHeight(id, 0)).toBe(Math.round(DEFAULT_ROW_HEIGHT) + 40);
    grid.destroy();
  });
});

describe('resize dimensions at different zoom levels', () => {
  it.each([0.5, 1, 2])('previews and saves the same minimum column width at %s zoom', async (zoom) => {
    const { wb, id, grid, guide } = await mount();
    grid.setZoom(zoom);
    await flush();
    const clip = grid.el.querySelector('.grid-colhead-clip');
    pe(clip.querySelector('.col-resizer[data-c="0"]'), 'pointerdown', 248, 10);
    pe(clip, 'pointermove', -200, 10);
    expect(grid.el.querySelector('.resize-feedback').textContent).toBe('Width: 24 px');
    // The row headings (48px at 100%) grow with a zoom above 100%.
    expect(guide.style.transform).toBe(`translateX(${48 * Math.max(1, zoom) + 24 * zoom}px)`);
    pe(clip, 'pointerup', -200, 10);
    expect(wb.colWidth(id, 0)).toBe(24);
    expect(grid.el.querySelector('.resize-feedback').hidden).toBe(true);
    wb.undo();
    expect(wb.colWidth(id, 0)).toBe(100);
    grid.destroy();
  });

  it.each([0.5, 1, 2])('previews and saves row size limits at %s zoom', async (zoom) => {
    const { wb, id, grid } = await mount();
    grid.setZoom(zoom);
    await flush();
    const clip = grid.el.querySelector('.grid-rowhead-clip');
    for (const [delta, expected] of [[-200, 18], [2000, 400]]) {
      pe(clip.querySelector('.row-resizer[data-r="0"]'), 'pointerdown', 20, 100);
      pe(clip, 'pointermove', 20, 100 + delta);
      expect(grid.el.querySelector('.resize-feedback').textContent).toBe(`Height: ${expected} px`);
      pe(clip, 'pointerup', 20, 100 + delta);
      expect(wb.rowHeight(id, 0)).toBe(expected);
      await flush();
    }
    grid.destroy();
  });

  it('reports a shared width when several columns are resized, and clamps the preview to the maximum', async () => {
    const { wb, id, grid } = await mount();
    grid.selectByName('A:C');
    await flush();
    const clip = grid.el.querySelector('.grid-colhead-clip');
    pe(clip.querySelector('.col-resizer[data-c="0"]'), 'pointerdown', 148, 10);
    pe(clip, 'pointermove', 1200, 10);
    expect(grid.el.querySelector('.resize-feedback').textContent).toBe('3 columns: 800 px');
    pe(clip, 'pointerup', 1200, 10);
    expect([0, 1, 2].map(c => wb.colWidth(id, c))).toEqual([800, 800, 800]);
    wb.undo();
    expect([0, 1, 2].map(c => wb.colWidth(id, c))).toEqual([100, 100, 100]);
    grid.destroy();
  });

  it('leaves imported widths outside interactive limits unchanged on a press without a drag', async () => {
    const { wb, id, grid } = await mount();
    wb.sheet(id).colWidths.set(0, 1200);
    grid.refresh();
    await flush();
    const clip = grid.el.querySelector('.grid-colhead-clip');
    pe(clip.querySelector('.col-resizer[data-c="0"]'), 'pointerdown', 1248, 10);
    expect(grid.el.querySelector('.resize-feedback').textContent).toBe('Width: 1200 px');
    pe(clip, 'pointerup', 1248, 10);
    expect(wb.colWidth(id, 0)).toBe(1200);
    expect(wb.undoLabels()).toEqual([]);
    grid.destroy();
  });
});
