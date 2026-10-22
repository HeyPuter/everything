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

function mount() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  for (let r = 0; r < 4; r++) wb.setInput(id, r, 0, String(r + 1));
  const said = [];
  const grid = createGrid({ wb, sheetId: id, announce: (text) => said.push(text) });
  document.body.replaceChildren(grid.el);
  const press = (key, extra = {}) => grid.viewport.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
  return { grid, said, press };
}

// End Mode, Extend Selection and Add to Selection showed in the status bar alone: a screen reader heard
// nothing when F8 or End was pressed, so the next arrow's jump or stretch came as a surprise.
it('tells a screen reader when F8, Shift+F8 or End turns a mode on or off', () => {
  const { grid, said, press } = mount();
  press('F8');
  expect(grid.keyMode).toBe('extend');
  expect(said.at(-1)).toBe('Extend Selection on');
  press('F8');
  expect(said.at(-1)).toBe('Extend Selection off');
  press('F8', { shiftKey: true });
  expect(said.at(-1)).toBe('Add to Selection on');
  press('Escape');
  expect(grid.keyMode).toBe(null);
  expect(said.at(-1)).toBe('Add to Selection off');
  press('End');
  expect(said.at(-1)).toBe('End Mode on');
});

it('reads out the cell an End Mode jump lands on, not the mode ending', () => {
  const { grid, said, press } = mount();
  press('End');
  press('ArrowDown');
  expect(grid.keyMode).toBe(null);
  expect(said.at(-1)).toBe('A4, 4');
});
