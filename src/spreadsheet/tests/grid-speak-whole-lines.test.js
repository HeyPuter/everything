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

// A screen reader heard whole columns as "B1:D1048576 selected" and whole rows as "A3:XFD5 selected",
// where the Name Box (and Excel) names them B:D and 3:5.
it('names whole columns and rows as the Name Box does when it reads out the selection', async () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 0, 1, 'Head');
  const spoken = [];
  const grid = createGrid({ wb, sheetId: id, announce: (m) => spoken.push(m) });
  document.body.replaceChildren(grid.el);
  await flush();
  grid.selectByName('B:D');
  expect(spoken.at(-1)).toBe('B:D selected. B1, Head');
  grid.selectByName('C4');
  key(grid.viewport, ' ', { shiftKey: true });
  expect(spoken.at(-1)).toBe('4:4 selected. C4, empty');
  grid.selectByName('A1:B2');
  expect(spoken.at(-1)).toBe('A1:B2 selected. A1, empty');
  grid.destroy();
});
