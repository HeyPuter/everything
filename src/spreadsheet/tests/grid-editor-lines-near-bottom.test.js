// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

let scrolls;
beforeEach(() => {
  scrolls = [];
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo(o) { scrolls.push(o); };
  Element.prototype.setPointerCapture = function () {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));

async function editAt(ref) {
  const wb = new Workbook();
  const grid = createGrid({ wb, sheetId: wb.sheets[0].id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  grid.selectByName(ref);
  await flush();
  grid.beginEdit({ text: '', mode: 'type' });
  scrolls.length = 0;
  return grid;
}

// Lines added with Alt+Enter grow the editor down from its cell. In a cell low on the screen there was
// no room for them: the box stopped at the viewport's bottom and showed the last line or two, cut off.
// The sheet now scrolls the cell up so the lines being typed show, as Excel keeps them in view.
it('lines typed into a cell near the bottom of the view scroll the sheet up to show them', async () => {
  const grid = await editAt('C19');
  grid.setEditText('line 1\nline 2\nline 3\nline 4\nline 5');
  expect(scrolls.length).toBeGreaterThan(0);
  expect(scrolls.at(-1).top).toBeGreaterThan(0);
  grid.destroy();
});

it('one line near the bottom, or several with room below, leaves the sheet where it is', async () => {
  let grid = await editAt('C19');
  grid.setEditText('one line only');
  expect(scrolls).toEqual([]);
  grid.destroy();
  grid = await editAt('C2');
  grid.setEditText('line 1\nline 2\nline 3');
  expect(scrolls).toEqual([]);
  grid.destroy();
});
