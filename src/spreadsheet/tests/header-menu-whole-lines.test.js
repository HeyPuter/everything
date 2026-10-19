// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
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
const flush = () => new Promise((r) => setTimeout(r, 5));

async function setup() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const menus = [];
  const grid = createGrid({ wb, sheetId: id, onContextMenu: (m) => menus.push(m) });
  document.body.replaceChildren(grid.el);
  await flush();
  const rightClick = (selector) => grid.el.querySelector(selector).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 10 }));
  return { wb, id, grid, menus, rightClick };
}

it('selects the whole column when its header is right-clicked over cells selected in it', async () => {
  const { grid, menus, rightClick } = await setup();
  grid.selectByName('B3:B5');
  rightClick('.grid-colhead .hcell[data-c="1"]');
  // The column menu's Clear Contents, Copy and Sort then act on column B, not on B3:B5 alone.
  expect(grid.ranges).toEqual([{ r1: 0, c1: 1, r2: grid.range.r2, c2: 1 }]);
  expect(grid.range.r2).toBeGreaterThan(100);
  expect(menus.at(-1)).toMatchObject({ kind: 'col' });
  grid.destroy();
});

it('selects the whole row when its header is right-clicked over cells selected in it', async () => {
  const { grid, rightClick } = await setup();
  grid.selectByName('A2:C2');
  rightClick('.grid-rowhead .hcell[data-r="1"]');
  expect(grid.range).toMatchObject({ r1: 1, r2: 1, c1: 0 });
  expect(grid.range.c2).toBeGreaterThan(20);
  grid.destroy();
});

it('keeps whole columns already selected, and every range of a Ctrl/Cmd+click selection of them', async () => {
  const { grid, rightClick } = await setup();
  grid.selectByName('B:D');
  rightClick('.grid-colhead .hcell[data-c="2"]');
  expect(grid.range).toMatchObject({ r1: 0, c1: 1, c2: 3 });
  grid.selectByName('A:A,C:C');
  rightClick('.grid-colhead .hcell[data-c="0"]');
  expect(grid.ranges.length).toBe(2);
  // The whole sheet selected keeps the whole sheet too.
  grid.selectAll(); grid.selectAll();
  rightClick('.grid-rowhead .hcell[data-r="3"]');
  expect(grid.range).toMatchObject({ r1: 0, c1: 0 });
  expect(grid.range.r2).toBeGreaterThan(100);
  expect(grid.range.c2).toBeGreaterThan(20);
  grid.destroy();
});

it('opens the header menu from the keyboard (Shift+F10, the Menu key) when whole columns or rows are selected', async () => {
  const { grid, menus } = await setup();
  const press = (key, init = {}) => grid.viewport.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  grid.selectByName('B:C');
  press('F10', { shiftKey: true });
  expect(menus.at(-1)).toMatchObject({ kind: 'col' });
  grid.selectByName('2:4');
  press('ContextMenu');
  expect(menus.at(-1)).toMatchObject({ kind: 'row' });
  grid.selectByName('B2:C4');
  press('F10', { shiftKey: true });
  expect(menus.at(-1)).toMatchObject({ kind: 'cell' });
  grid.selectAll(); grid.selectAll();
  press('ContextMenu');
  expect(menus.at(-1)).toMatchObject({ kind: 'cell' });
  grid.destroy();
});
