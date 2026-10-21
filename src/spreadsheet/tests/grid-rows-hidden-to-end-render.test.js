// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// Rows hidden from under a list to the sheet's end (select below the data, Ctrl+Shift+Down, Hide) left the view
// reaching to the sheet's last row, past the last row drawn, so every frame walked the million hidden rows to
// draw none of them: 112 ms per edit or selection move in the app against 15 ms with the rows shown. The view now
// ends at the last row that has a height.

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 1200; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));

it('draws the rows above hidden rows running to the sheet end without walking the hidden ones', async () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  for (let r = 0; r < 20; r++) wb.setInput(id, r, 0, String(r + 1));
  wb.ensureSize(id, 1048576, 26);
  expect(wb.setHidden(id, 'row', Array.from({ length: 1048576 - 30 }, (_, i) => i + 30), true)).toBe(true);
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  const hidden = wb.sheet(id).hiddenRows;
  const has = hidden.has.bind(hidden);
  let reads = 0;
  hidden.has = (i) => { reads++; return has(i); };
  wb.setInput(id, 5, 1, 'x');
  await flush();
  expect(reads).toBeLessThan(10000);
  // Every row shown is drawn, and its heading too; the hidden ones are not.
  expect(grid.el.querySelector('#gc-5-1')?.textContent).toBe('x');
  expect(grid.el.querySelector('#gc-29-0')).not.toBeNull();
  expect(grid.el.querySelector('#gc-30-0')).toBeNull();
  const headings = [...grid.el.querySelectorAll('.hcell[data-r]')].map((h) => Number(h.dataset.r));
  expect(headings).toContain(29);
  expect(Math.max(...headings)).toBe(29);
  grid.destroy();
});
