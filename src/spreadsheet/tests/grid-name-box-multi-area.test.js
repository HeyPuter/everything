// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';
import { setLocale } from '../src/core/format.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { setLocale('en-US'); document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));
async function setup() {
  const wb = new Workbook();
  const grid = createGrid({ wb, sheetId: wb.sheets[0].id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  return { wb, grid };
}

// Excel's Name Box takes several areas separated by the list separator; the box refused them.
it('selects several areas typed into the name box', async () => {
  const { grid } = await setup();
  expect(grid.selectByName('A1:A2,C5:C6')).toBe(true);
  expect(grid.ranges).toEqual([{ r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 4, c1: 2, r2: 5, c2: 2 }]);
  expect(grid.active).toEqual({ r: 4, c: 2 });
  // Cells, whole columns and rows mix, with spaces around the separator.
  expect(grid.selectByName('B2, D:E , 7:7')).toBe(true);
  expect(grid.ranges.length).toBe(3);
  expect(grid.ranges[0]).toEqual({ r1: 1, c1: 1, r2: 1, c2: 1 });
  expect(grid.ranges[1]).toMatchObject({ r1: 0, c1: 3, c2: 4 });
  expect(grid.formatRanges[1].scope).toBe('columns');
  expect(grid.ranges[2]).toMatchObject({ r1: 6, c1: 0, r2: 6 });
  grid.destroy();
});

it('leaves the selection alone when one of the areas is not a place', async () => {
  const { grid } = await setup();
  grid.selectByName('B3');
  expect(grid.selectByName('A1:A2,Nope')).toBe(false);
  expect(grid.selectByName('A1:A2,')).toBe(false);
  expect(grid.ranges).toEqual([{ r1: 2, c1: 1, r2: 2, c2: 1 }]);
  expect(grid.active).toEqual({ r: 2, c: 1 });
  grid.destroy();
});

it('takes the semicolon where the regional format writes decimals with a comma', async () => {
  const { grid } = await setup();
  expect(grid.selectByName('A1;B2')).toBe(false);
  setLocale('de-DE');
  expect(grid.selectByName('A1:A2;C5:C6')).toBe(true);
  expect(grid.ranges).toEqual([{ r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 4, c1: 2, r2: 5, c2: 2 }]);
  grid.destroy();
});
