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
const pointer = (target, type, init) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'mouse', ...init }));

async function mount() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 1, 1, 'keep');
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  await flush();
  grid.selectByName('B2');
  return { wb, id, grid };
}

// The right edge of B2, and of D2 once dragged two columns along.
const edge = (c) => ({ clientX: (c + 1) * DEFAULT_COL_WIDTH - 1, clientY: 1.5 * DEFAULT_ROW_HEIGHT });

// Dragging a selection by its border moves it, and with Ctrl (or Alt) held copies it. Which one happened
// was read from the keys at the last move of the mouse: Ctrl pressed after it, just before letting go, still
// moved the cells out of their place. As in Excel, the keys held at the drop now decide.
it('copies when Ctrl is held as the block is dropped, though not while it was dragged', async () => {
  const { wb, id, grid } = await mount();
  pointer(grid.viewport, 'pointerdown', edge(1));
  pointer(grid.viewport, 'pointermove', edge(3));
  pointer(grid.viewport, 'pointerup', { ...edge(3), ctrlKey: true });
  expect(wb.getValue(id, 1, 3)).toBe('keep');
  expect(wb.getValue(id, 1, 1)).toBe('keep');
  grid.destroy();
});

it('moves when Ctrl is let go before the drop', async () => {
  const { wb, id, grid } = await mount();
  pointer(grid.viewport, 'pointerdown', { ...edge(1), ctrlKey: true });
  pointer(grid.viewport, 'pointermove', { ...edge(3), ctrlKey: true });
  pointer(grid.viewport, 'pointerup', edge(3));
  expect(wb.getValue(id, 1, 3)).toBe('keep');
  expect(wb.getValue(id, 1, 1)).toBe(null);
  grid.destroy();
});
