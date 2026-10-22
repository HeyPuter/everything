// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook, DEFAULT_ROW_HEIGHT, DEFAULT_COL_WIDTH } from '../src/core/workbook.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  Element.prototype.releasePointerCapture = function releasePointerCapture() {};
  Element.prototype.hasPointerCapture = function hasPointerCapture() { return false; };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));
const key = (target, k, init = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
const pointer = (target, type, init) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'mouse', ...init }));

// Space (or a click) on a checkbox cell ticks it, but the cell stays the active one, so a screen reader
// following the grid's cursor heard nothing of the change. The new state is now read out.
it('reads out the new state of a checkbox ticked with Space or a click', async () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.addValidation(id, { range: { r1: 1, c1: 1, r2: 1, c2: 1 }, type: 'checkbox' });
  const spoken = [];
  const grid = createGrid({ wb, sheetId: id, announce: (m) => spoken.push(m) });
  document.body.replaceChildren(grid.el);
  await flush();
  grid.selectByName('B2');
  key(grid.viewport, ' ');
  expect(wb.getValue(id, 1, 1)).toBe(true);
  expect(spoken.at(-1)).toBe('B2, checked');
  const at = { clientX: 1.5 * DEFAULT_COL_WIDTH, clientY: 1.5 * DEFAULT_ROW_HEIGHT };
  pointer(grid.viewport, 'pointerdown', at);
  pointer(grid.viewport, 'pointerup', at);
  expect(wb.getValue(id, 1, 1)).toBe(false);
  expect(spoken.at(-1)).toBe('B2, not checked');
  grid.destroy();
});
