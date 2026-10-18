// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// A press within 4px of the selection's border takes hold of the selection, to drag it elsewhere. Zoomed
// out to a third a row is 7px tall, so that band took the middle of the rows above and below the
// selection: clicking the cell under (or over) the active cell grabbed the border and selected nothing.
// The band is now no more than a quarter of the cell under the pointer; the border still drags.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: t => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function ({ left, top }) { this.scrollLeft = left; this.scrollTop = top; };
  Element.prototype.setPointerCapture = function () {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
});
afterEach(() => { document.body.replaceChildren(); });

function mount() {
  const wb = new Workbook({ sheets: [{ name: 'Data', rows: 100, cols: 20 }] });
  const grid = createGrid({ wb, sheetId: wb.activeSheetId, announce() {} });
  document.body.append(grid.el);
  grid.viewport.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 });
  const pointer = (type, x, y) => grid.viewport.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'mouse', clientX: x, clientY: y }));
  const click = (x, y) => { pointer('pointerdown', x, y); pointer('pointerup', x, y); };
  const middle = (r, c) => { const rect = grid.cellRect(r, c); return [rect.left + rect.width / 2, rect.top + rect.height / 2]; };
  return { wb, grid, click, pointer, middle };
}

it('selects the cell above or below the active one when clicked, zoomed out to a third', () => {
  const { grid, click, middle } = mount();
  grid.setZoom(0.33);
  for (const [r, c] of [[5, 2], [3, 2], [4, 3], [4, 1]]) {
    grid.selectByName('C5');
    click(...middle(r, c));
    expect(grid.range).toEqual({ r1: r, c1: c, r2: r, c2: c });
  }
  grid.destroy();
});

it('still takes hold of the border to move the selection', () => {
  const { wb, grid, pointer } = mount();
  const id = wb.activeSheetId;
  wb.setInput(id, 4, 2, 'moved');
  grid.setZoom(0.33);
  grid.selectByName('C5');
  const rect = grid.cellRect(4, 2);
  const x = rect.left + rect.width / 2;
  pointer('pointerdown', x, rect.bottom);
  pointer('pointermove', x, rect.bottom + rect.height * 3);
  pointer('pointerup', x, rect.bottom + rect.height * 3);
  expect(wb.getValue(id, 4, 2)).toBe(null);
  expect(wb.getValue(id, 7, 2)).toBe('moved');
  grid.destroy();
});
