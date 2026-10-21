// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

let scroll = { top: 0, left: 0 };
beforeEach(() => {
  scroll = { top: 0, left: 0 };
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

// Find's highlight (and Circle Invalid Data's circle) on a match in a merged block outlined only the
// block's top-left cell, a box inside the merged title that matched; and once that first cell scrolled
// out of view, the rest of the block still on screen lost its highlight altogether.
it('outlines a match in a merged block whole, while any of the block is in view', async () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 0, 0, 'Quarterly report');
  wb.mergeCells(id, { r1: 0, c1: 0, r2: 1, c2: 2 });
  wb.setInput(id, 40, 1, 'Report notes');
  wb.mergeCells(id, { r1: 40, c1: 1, r2: 60, c2: 1 });
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  const viewport = grid.el.querySelector('.grid-viewport');
  Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => scroll.top, set: (v) => { scroll.top = v; } });
  await flush();
  grid.setHighlights([{ r: 0, c: 0 }, { r: 40, c: 1 }], 0);
  await flush();
  const marks = () => [...grid.el.querySelectorAll('.grid-canvas > .hl-layer .find-hl')];
  const title = grid.cellRect(0, 0), end = grid.cellRect(1, 2);
  expect(marks()).toHaveLength(1);
  expect(parseFloat(marks()[0].style.width)).toBe(end.right - title.left);
  expect(parseFloat(marks()[0].style.height)).toBe(end.bottom - title.top);
  // Scrolled so the tall block's first row is above the view while its lower rows are on screen.
  scroll.top = 50 * 20;
  viewport.dispatchEvent(new Event('scroll'));
  await flush();
  const shown = marks();
  expect(shown).toHaveLength(1);
  expect(parseFloat(shown[0].style.height)).toBe(grid.cellRect(60, 1).bottom - grid.cellRect(40, 1).top);
  grid.destroy();
});
