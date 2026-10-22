// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createGrid } from '../src/ui/grid.js';
import { declared, stylesheet } from './helpers/css.js';

// A filtered list's last header, longer than its column, runs over the empty cell beside it, and its filter button
// went with the text to the end of the run: it was drawn in that empty cell, where a click selects the cell, while
// the place that opens the menu, in the header's own cell, showed nothing. The button now stays at its own cell's
// right edge, over the text running past it, as Excel draws it.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: t => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = () => {};
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
});
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

it('keeps the filter button of a spilled header in the header’s own cell', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Region', 'Revenue for the year'], ['East', '10'], ['West', '20']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  wb.setFilterRange(id, { r1: 0, c1: 0, r2: 2, c2: 1 });
  const grid = createGrid({ wb, sheetId: id }); document.body.append(grid.el);
  await new Promise(resolve => setTimeout(resolve, 10));
  const head = grid.el.querySelector('#gc-0-1');
  expect(head.classList.contains('filter-head')).toBe(true);
  expect(head.classList.contains('spill')).toBe(true);
  const ownWidth = wb.colWidth(id, 1) * grid.zoom;
  const spilled = parseFloat(head.style.width) - ownWidth;
  expect(spilled).toBeGreaterThan(0);
  expect(parseFloat(head.style.getPropertyValue('--spill-right'))).toBeCloseTo(spilled, 5);
  expect(grid.el.querySelector('#gc-0-0').style.getPropertyValue('--spill-right')).toBe('');
  for (const sheet of ['grid.css', 'chrome.css']) expect(declared(stylesheet(sheet), '.cell.filter-head::after').right).toMatch(/var\(--spill-right, 0px\)/);
});
