// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// The fill handle takes a press over a 19px square (grid.css: the 9px handle and 5px around it). Zoomed out to
// a quarter a cell is 16 by 5 pixels, so that square took the middle of the cells above and below the active
// cell: clicking them landed on the handle and selected nothing. The handle's reach now stops short of the
// middle of the cells beside its corner, and keeps its whole hit area where the cells are larger than it.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: t => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function ({ left, top }) { this.scrollLeft = left; this.scrollTop = top; };
  Element.prototype.scrollBy = function () {};
  Element.prototype.setPointerCapture = function () {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
});
afterEach(() => { document.body.replaceChildren(); });

const frame = () => new Promise((r) => setTimeout(r, 5));

async function mount(zoom) {
  const wb = new Workbook({ sheets: [{ name: 'Data', rows: 100, cols: 20, defaultColWidth: 64 }] });
  const id = wb.activeSheetId;
  wb.setInput(id, 4, 2, 7);
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.append(grid.el);
  grid.viewport.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 });
  grid.setZoom(zoom);
  grid.selectByName('C5');
  await frame();
  const handle = grid.el.querySelector('.grid-canvas > .fill-handle');
  // The browser reports a press inside the handle's hit area on the handle itself.
  const press = (type, x, y) => handle.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'mouse', clientX: x, clientY: y }));
  const middle = (r, c) => { const rect = grid.cellRect(r, c); return [rect.left + rect.width / 2, rect.top + rect.height / 2]; };
  return { wb, id, grid, handle, press, middle };
}

it('lets a click in the middle of the cell under or over the active one select it at 25%', async () => {
  const { grid, handle, press, middle } = await mount(0.25);
  expect(handle.classList.contains('tight')).toBe(true);
  for (const [r, c] of [[5, 2], [3, 2]]) {
    grid.selectByName('C5');
    press('pointerdown', ...middle(r, c));
    press('pointerup', ...middle(r, c));
    expect(grid.range).toEqual({ r1: r, c1: c, r2: r, c2: c });
  }
  grid.destroy();
});

it('still fills from a press on the handle at 25%', async () => {
  const { wb, id, grid, press } = await mount(0.25);
  const corner = grid.cellRect(4, 2);
  press('pointerdown', corner.right, corner.bottom);
  const below = grid.cellRect(7, 2);
  grid.viewport.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, pointerType: 'mouse', clientX: below.left + 2, clientY: below.top + 2 }));
  grid.viewport.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse', clientX: below.left + 2, clientY: below.top + 2 }));
  expect(wb.getValue(id, 7, 2)).toBe(7);
  grid.destroy();
});

it('keeps the handle\'s whole hit area at 100%', async () => {
  const { grid, handle, press } = await mount(1);
  expect(handle.classList.contains('tight')).toBe(false);
  const corner = grid.cellRect(4, 2);
  // 9px below and right of the corner: outside the 7px reach, inside the handle's drawn hit area.
  press('pointerdown', corner.right + 9, corner.bottom + 9);
  press('pointerup', corner.right + 9, corner.bottom + 9);
  expect(grid.range).toEqual({ r1: 4, c1: 2, r2: 4, c2: 2 });
  grid.destroy();
});
