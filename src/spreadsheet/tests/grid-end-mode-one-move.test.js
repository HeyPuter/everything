// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
const key = (target, k, init = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

/** A column of data A1:A10, A1 selected. */
async function mount() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  for (let r = 0; r < 10; r++) wb.setInput(id, r, 0, String(r));
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  await flush();
  grid.selectByName('A1');
  return { grid, wb, id };
}

// End turns on End Mode for the next move only. Any other key left it on: End, then an entry typed and
// Enter, and the next Down arrow jumped to the end of the data instead of stepping one row, with
// "End Mode" still in the status bar all the while. In Excel any other key ends it.
describe('End Mode lasts for one move', () => {
  it('ends when an entry is typed', async () => {
    const { grid, wb, id } = await mount();
    key(grid.viewport, 'End');
    expect(grid.keyMode).toBe('end');
    key(grid.viewport, 'x');
    expect(grid.keyMode).toBe(null);
    key(grid.el.querySelector('.grid-editor'), 'Enter');
    expect(wb.getValue(id, 0, 0)).toBe('x');
    expect(grid.active).toEqual({ r: 1, c: 0 });
    key(grid.viewport, 'ArrowDown');
    expect(grid.active).toEqual({ r: 2, c: 0 });
    grid.destroy();
  });

  it('ends with Enter, Tab or a Ctrl chord', async () => {
    const { grid } = await mount();
    for (const [k, init] of [['Enter', {}], ['Tab', {}], ['ArrowDown', { ctrlKey: true, metaKey: true }], ['Home', { ctrlKey: true, metaKey: true }]]) {
      key(grid.viewport, 'End');
      expect(grid.keyMode).toBe('end');
      key(grid.viewport, k, init);
      expect(grid.keyMode).toBe(null);
    }
    grid.destroy();
  });

  it('still waits through Shift for the arrow, and jumps with it', async () => {
    const { grid } = await mount();
    key(grid.viewport, 'End');
    key(grid.viewport, 'Shift', { shiftKey: true });
    expect(grid.keyMode).toBe('end');
    key(grid.viewport, 'ArrowDown', { shiftKey: true });
    expect(grid.range).toEqual({ r1: 0, c1: 0, r2: 9, c2: 0 });
    expect(grid.keyMode).toBe(null);
    grid.destroy();
  });
});
