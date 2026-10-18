// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createGrid } from '../src/ui/grid.js';

// A slicer set to "Disable resizing and moving" could not be dragged, but the arrow keys still moved
// it, alone or with other selected objects. It now stays put under the keys too.
let grid;
const flush = () => new Promise(resolve => setTimeout(resolve, 10));
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: t => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = () => {}; Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
});
afterEach(() => { grid?.destroy(); grid = null; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const arrow = (key, init = {}) => grid.viewport.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));

it('keeps a slicer whose position is locked in place under the arrow keys', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  ['Category', 'Alpha', 'Beta'].forEach((v, r) => wb.setInput(id, r, 0, v));
  wb.addTable(id, { r1: 0, c1: 0, r2: 2, c2: 0 }, { name: 'Orders' });
  const slicer = wb.addChart(id, { type: 'slicer', anchor: { r: 4, c: 0 }, tableRef: 'Orders[Category]', title: 'Category', w: 200, h: 140, lockedPosition: true });
  const text = wb.addChart(id, { type: 'text', text: 'Note', anchor: { r: 4, c: 6 }, w: 120, h: 60 });
  grid = createGrid({ wb, sheetId: id }); document.body.append(grid.el); await flush();
  const where = (obj) => { const ch = wb.chartById(id, obj); return [ch.anchor.r, ch.anchor.c, ch.dx, ch.dy]; };
  const before = where(slicer), textBefore = where(text);
  grid.selectChart(slicer);
  arrow('ArrowRight'); arrow('ArrowDown', { shiftKey: true });
  expect(where(slicer)).toEqual(before);
  grid.selectChart(text, { add: true });
  arrow('ArrowRight');
  expect(where(slicer)).toEqual(before);
  expect(where(text)).not.toEqual(textBefore);
});
