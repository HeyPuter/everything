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

// A link on a cell holding a number, a date or TRUE/FALSE (an order number linking to its record, as
// Insert ▸ Link or a workbook from Excel leaves it) was drawn as plain text: only text and formulas were
// asked for their link, so nothing told the cell was a link until it was selected.
it('draws a cell linked from a number, date or logical value as a link', async () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 0, 0, '42');
  wb.setLink(id, 0, 0, 'https://example.com/orders/42', 42);
  wb.setInput(id, 1, 0, '2024-05-01');
  wb.setLink(id, 1, 0, 'https://example.com/day', wb.getValue(id, 1, 0));
  wb.setInput(id, 2, 0, 'TRUE');
  wb.setLink(id, 2, 0, 'https://example.com/flag', true);
  wb.setInput(id, 3, 0, '7'); // no link
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  await flush();
  for (const r of [0, 1, 2]) {
    const node = grid.el.querySelector(`#gc-${r}-0`);
    expect(node.classList.contains('link'), `row ${r + 1}`).toBe(true);
    expect(node.title).toMatch(/^https:\/\/example\.com\//);
  }
  expect(grid.el.querySelector('#gc-0-0').textContent).toBe('42');
  expect(grid.el.querySelector('#gc-3-0').classList.contains('link')).toBe(false);
  grid.destroy();
});
