// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));
const key = (target, k, init = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

// Every frame marks the selected cells for assistive technology (aria-selected). It did so by visiting
// every cell drawn, twice: zoomed out to 10% a view holds some 55,000 cells, and the marking alone took
// about 15ms of each frame of a scroll and of each arrow press. Only the rows the selection crosses are
// walked now, and only the cells marked before are unmarked.
it('marks the selection without visiting every cell drawn', async () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  grid.setZoom(0.25);
  await flush();
  const layer = grid.el.querySelector('.grid-cells');
  expect(layer.querySelectorAll('.cell').length).toBeGreaterThan(2000);
  const scans = [];
  const own = layer.querySelectorAll.bind(layer);
  layer.querySelectorAll = (selector) => { scans.push(selector); return own(selector); };
  key(grid.viewport, 'ArrowDown');
  await flush();
  expect(scans.filter((s) => s.includes('.cell'))).toEqual([]);
  grid.destroy();
});

it('still marks every cell of every range, and unmarks them when the selection moves on', async () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  await flush();
  const marked = () => [...grid.el.querySelectorAll('.cell[aria-selected="true"]')].map((n) => n.id).sort();
  grid.selectByName('A1:B2,D4');
  await flush();
  expect(marked()).toEqual(['gc-0-0', 'gc-0-1', 'gc-1-0', 'gc-1-1', 'gc-3-3']);
  key(grid.viewport, 'ArrowRight');
  await flush();
  expect(marked()).toEqual(['gc-3-4']);
  grid.destroy();
});
