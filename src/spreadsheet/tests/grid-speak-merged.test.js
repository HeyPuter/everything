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


// A merged block was read out as its first cell alone ("A2, Title"), so it could not be told from a plain
// cell, nor how far it reaches: the next arrow then landed columns or rows along without a word why.
it('says a merged cell is merged, and over which cells', () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 1, 0, 'Title');
  wb.mergeCells(id, { r1: 1, c1: 0, r2: 2, c2: 2 });
  const said = [];
  const grid = createGrid({ wb, sheetId: id, announce: (text) => said.push(text) });
  document.body.replaceChildren(grid.el);
  const press = (key) => grid.viewport.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  press('ArrowDown');
  expect(said.at(-1)).toBe('A2, Title, merged A2:C3');
  press('ArrowDown');
  expect(said.at(-1)).toBe('A4, empty');
});
