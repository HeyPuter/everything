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
const press = (grid, key, init = {}) => grid.viewport.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
const mod = { ctrlKey: true, metaKey: true };

/** A block of data B2:D10, with C5 selected and Extend Selection (F8) turned on. */
async function mount() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  for (let r = 1; r <= 9; r++) for (let c = 1; c <= 3; c++) wb.setInput(id, r, c, String(r * 10 + c));
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  await flush();
  grid.selectByName('C5');
  press(grid, 'F8');
  expect(grid.keyMode).toBe('extend');
  return grid;
}

// In Excel's Extend Selection mode (F8) every move stretches the selection from where it began, as if Shift
// were held. Only the plain arrows did: Ctrl+arrow, Home, Ctrl+Home, Ctrl+End and PageDown moved the cursor
// and dropped the selection, though the status bar still said Extend Selection.
describe('Extend Selection (F8) stretches the selection with every move', () => {
  it('Ctrl+arrow stretches to the edge of the data', async () => {
    const grid = await mount();
    press(grid, 'ArrowDown', mod);
    expect(grid.ranges).toEqual([{ r1: 4, c1: 2, r2: 9, c2: 2 }]);
    press(grid, 'ArrowRight', mod);
    expect(grid.ranges).toEqual([{ r1: 4, c1: 2, r2: 9, c2: 3 }]);
    expect(grid.selection.active).toEqual({ r: 4, c: 2 });
    grid.destroy();
  });

  it('Ctrl+End and Ctrl+Home stretch to the last cell and the first', async () => {
    const grid = await mount();
    press(grid, 'End', mod);
    expect(grid.ranges).toEqual([{ r1: 4, c1: 2, r2: 9, c2: 3 }]);
    press(grid, 'Home', mod);
    expect(grid.ranges).toEqual([{ r1: 0, c1: 0, r2: 4, c2: 2 }]);
    grid.destroy();
  });

  it('Home stretches to the start of the row', async () => {
    const grid = await mount();
    press(grid, 'Home');
    expect(grid.ranges).toEqual([{ r1: 4, c1: 0, r2: 4, c2: 2 }]);
    grid.destroy();
  });

  it('PageDown stretches a page down', async () => {
    const grid = await mount();
    press(grid, 'PageDown');
    const [range] = grid.ranges;
    expect(range.r1).toBe(4);
    expect(range.r2).toBeGreaterThan(10);
    expect(grid.selection.active).toEqual({ r: 4, c: 2 });
    grid.destroy();
  });

  it('without F8 the same keys still move the cursor alone', async () => {
    const grid = await mount();
    press(grid, 'F8');
    expect(grid.keyMode).toBe(null);
    press(grid, 'ArrowDown', mod);
    expect(grid.ranges).toEqual([{ r1: 9, c1: 2, r2: 9, c2: 2 }]);
    press(grid, 'Home');
    expect(grid.ranges).toEqual([{ r1: 9, c1: 0, r2: 9, c2: 0 }]);
    grid.destroy();
  });
});
