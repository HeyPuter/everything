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

// A report merged across each of its rows brings tens of thousands of merges. Each cell the grid drew tested
// every one of them, so with 100,000 an edit or a scroll spent 40ms looking for merges alone. The cells drawn
// now look only among the merges filed near their row.
it('drawing the cells after an edit does not test every merge of the sheet for every cell', async () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const blocks = [];
  for (let r = 0; r < 5000; r++) blocks.push({ r1: r, c1: 0, r2: r, c2: 2 });
  wb.mergeBlocks(id, blocks);
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  await flush();

  // Count the merges read while the cells are drawn again after an edit.
  const s = wb.sheet(id);
  let reads = 0;
  s.merges = new Proxy(s.merges, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); } });
  wb.setInput(id, 2, 5, 'x');
  await flush();
  expect(grid.el.querySelector('#gc-2-5')?.textContent).toBe('x');
  expect(grid.el.querySelector('#gc-3-0')).toBeTruthy();
  // The edit's own bookkeeping goes over the list a few times (about 50,000 reads); testing each cell drawn
  // against all of them read three million.
  expect(reads).toBeLessThan(20 * blocks.length);
  grid.destroy();
});
