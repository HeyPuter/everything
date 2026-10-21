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

async function mount(zoom = 1) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 0, 1, 'Head');
  wb.setInput(id, 1, 1, 'a');
  wb.setFilterRange(id, { r1: 0, c1: 1, r2: 1, c2: 1 });
  const opened = [];
  const grid = createGrid({ wb, sheetId: id, onFilterOpen: (o) => opened.push([o.r, o.c]) });
  document.body.replaceChildren(grid.el);
  grid.setZoom(zoom);
  await flush();
  const press = (x, y) => {
    grid.viewport.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0 }));
    grid.viewport.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0 }));
  };
  return { grid, opened, press, rect: grid.cellRect(0, 1) };
}

// A filter button is drawn 16px tall in the middle of its cell, at every zoom, but a press opened it only
// between 2px below the cell's top and 8px above its bottom (kept clear of the fill handle's corner): the
// lower part of the button only selected the cell, and zoomed out to 50%, where a row is 10px tall, the
// band was a single pixel, so the button could hardly be pressed at all.
it('opens the filter from the lower half of its button', async () => {
  const { grid, opened, press, rect } = await mount();
  press(rect.right - 12, rect.top + rect.height / 2 + 6);
  expect(opened).toEqual([[0, 1]]);
  grid.destroy();
});

it('opens the filter from the middle of its button zoomed out to 50%', async () => {
  const { grid, opened, press, rect } = await mount(0.5);
  expect(rect.height).toBeLessThan(12);
  press(rect.right - 12, rect.top + rect.height / 2);
  expect(opened).toEqual([[0, 1]]);
  grid.destroy();
});

it('leaves the fill handle at the corner of the selected header cell its press', async () => {
  const { grid, opened, press, rect } = await mount();
  grid.selectByName('B1');
  await flush();
  press(rect.right - 1, rect.bottom - 1);
  expect(opened).toEqual([]);
  grid.destroy();
});
