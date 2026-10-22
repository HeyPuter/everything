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
const whole = { r1: 0, c1: 0, r2: 1048575, c2: 16383 };

async function mount() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  await flush();
  return { wb, id, grid };
}

// Selecting the whole sheet (Ctrl+A on an empty stretch, or the corner button) moved the active cell to A1.
// In Excel and Sheets it stays where it was: the next entry typed went into A1 instead, and the sheet jumped
// back to the top to show it.
describe('selecting the whole sheet keeps the active cell', () => {
  it('Ctrl+A', async () => {
    const { grid } = await mount();
    grid.selectByName('D20');
    key(grid.viewport, 'a', { ctrlKey: true, metaKey: true });
    expect(grid.range).toEqual(whole);
    expect(grid.active).toEqual({ r: 19, c: 3 });
    key(grid.viewport, 'a', { ctrlKey: true, metaKey: true });
    expect(grid.active).toEqual({ r: 19, c: 3 });
    grid.destroy();
  });

  it('the select-all corner, with typing then going into the active cell', async () => {
    const { grid } = await mount();
    grid.selectByName('D20');
    grid.el.querySelector('.grid-corner').click();
    expect(grid.range).toEqual(whole);
    expect(grid.active).toEqual({ r: 19, c: 3 });
    key(grid.viewport, 'x');
    expect(grid.editState).toMatchObject({ r: 19, c: 3 });
    grid.destroy();
  });
});
