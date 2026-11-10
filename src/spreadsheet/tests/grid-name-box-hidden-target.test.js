// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook, DEFAULT_ROW_HEIGHT } from '../src/core/workbook.js';

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

const ROW = Math.round(DEFAULT_ROW_HEIGHT); // a default row on screen at 100%
const flush = () => new Promise((r) => setTimeout(r, 5));

async function mount(prepare) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  prepare(wb, id);
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  return { wb, id, grid };
}

// The name box could put the active cell in a hidden row: no cell node existed for it, the grid's
// aria-activedescendant dangled, and typing opened an editor 0px tall that nobody could see.
describe('a hidden cell named in the name box', () => {
  it('puts the active cell on the nearest shown cell below instead', async () => {
    const { grid } = await mount((wb, id) => { wb.setHidden(id, 'row', [4], true); });
    expect(grid.selectByName('B5')).toBe(true);
    expect(grid.active).toEqual({ r: 5, c: 1 });
    await flush();
    expect(grid.el.querySelector('#gc-5-1')).toBeTruthy();
    expect(grid.viewport.getAttribute('aria-activedescendant')).toBe('gc-5-1');
    grid.beginEdit({ text: 'x' });
    expect(grid.el.querySelector('.grid-editor').style.height).toBe(`${ROW}px`); // a whole row, not a hidden one's 0px
    grid.cancelEdit();
    grid.destroy();
  });

  it('steps past a hidden column the same way', async () => {
    const { grid } = await mount((wb, id) => { wb.setHidden(id, 'col', [1], true); });
    expect(grid.selectByName('B5')).toBe(true);
    expect(grid.active).toEqual({ r: 4, c: 2 });
    grid.destroy();
  });

  it('goes past a hidden block to the shown row below it, the grid having grown to fill the window', async () => {
    const { grid } = await mount((wb, id) => { wb.setHidden(id, 'row', Array.from({ length: 96 }, (_, i) => i + 4), true); });
    expect(grid.selectByName('A10')).toBe(true);
    expect(grid.active).toEqual({ r: 100, c: 0 });
    grid.destroy();
  });

  it('keeps a range naming hidden lines, with the active cell on a shown cell of it, as before', async () => {
    const { grid } = await mount((wb, id) => { wb.setHidden(id, 'row', [4], true); });
    expect(grid.selectByName('B5:B7')).toBe(true);
    expect(grid.range).toEqual({ r1: 4, c1: 1, r2: 6, c2: 1 });
    expect(grid.active).toEqual({ r: 5, c: 1 });
    grid.destroy();
  });

  // A range of hidden lines alone keeps its active cell there (so Unhide knows the lines meant). The cell is drawn
  // for aria-activedescendant when the frame is rebuilt, but a selection inside the rows and columns already drawn
  // kept the frame as it was, which leaves hidden cells out: the screen reader's cursor named a node that did not exist.
  it('keeps a node for an active cell left in a hidden column inside the cells drawn', async () => {
    const { grid } = await mount((wb, id) => { wb.setHidden(id, 'col', [0], true); });
    expect(grid.selectByName('A19:A20')).toBe(true);
    expect(grid.active).toEqual({ r: 18, c: 0 });
    await flush();
    expect(grid.viewport.getAttribute('aria-activedescendant')).toBe('gc-18-0');
    expect(grid.el.querySelector('#gc-18-0')).toBeTruthy();
    grid.destroy();
  });
});
