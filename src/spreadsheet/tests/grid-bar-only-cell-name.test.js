// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';

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

// A data bar or icon set shown without its value ("Show the bar only" / "Show the icon only") left the cell with
// no text at all, so a screen reader moving onto it heard a blank cell. The value stays the cell's name.
it('keeps the value as the name of a cell that shows only its bar or icon', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  ['10', '20', '30'].forEach((v, r) => { wb.setInput(id, r, 0, v); wb.setInput(id, r, 1, v); wb.setInput(id, r, 2, v); });
  wb.applyStyle(id, parseRange('A1:A3'), { fmt: 'currency' });
  wb.addRule(id, { range: parseRange('A1:A3'), type: 'databar', barOnly: true, style: {} });
  wb.addRule(id, { range: parseRange('B1:B3'), type: 'icons', set: 'arrows', iconOnly: true, style: {} });
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  const cell = (r, c) => grid.el.querySelector(`#gc-${r}-${c}`);
  expect(cell(1, 0).textContent).toBe('');
  expect(cell(1, 0).getAttribute('aria-label')).toBe('$20.00');
  expect(cell(2, 1).getAttribute('aria-label')).toBe('30');
  expect(cell(2, 2).hasAttribute('aria-label')).toBe(false);
  grid.destroy();
});
