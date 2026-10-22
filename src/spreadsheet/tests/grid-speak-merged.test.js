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

// A checkbox cell, drawn as a box, was read out as "TRUE" or "FALSE", and a link as plain text.
it('reads a checkbox as checked or not, and says a link is one', () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.addValidation(id, { range: { r1: 1, c1: 0, r2: 2, c2: 0 }, type: 'checkbox' });
  wb.setInput(id, 1, 0, 'TRUE');
  wb.setInput(id, 2, 0, 'FALSE');
  wb.setInput(id, 3, 0, 'https://example.com');
  const said = [];
  const grid = createGrid({ wb, sheetId: id, announce: (text) => said.push(text) });
  document.body.replaceChildren(grid.el);
  const press = (key) => grid.viewport.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  press('ArrowDown');
  expect(said.at(-1)).toBe('A2, checkbox, checked');
  press('ArrowDown');
  expect(said.at(-1)).toBe('A3, checkbox, not checked');
  press('ArrowDown');
  expect(said.at(-1)).toBe('A4, https://example.com, link');
});
