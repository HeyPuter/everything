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


async function mount(prepare) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  prepare(wb, id);
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await new Promise((r) => setTimeout(r, 5));
  return { grid, node: (r, c) => grid.el.querySelector(`#gc-${r}-${c}`) };
}

// A border shared by two cells is drawn by the lower (or right) one, inside its own box, and the cell above (or to
// the left) kept its grey gridline beside it: every top and left edge of a box, and every line inside one, showed
// as a grey line and a black one, two pixels to the bottom and right edges' one. The gridline now gives way.
it('drops the gridline beside a border the cell below or to the right draws', async () => {
  const { grid, node } = await mount((wb, id) => {
    wb.setInput(id, 2, 2, 'x');
    wb.applyBorders(id, { r1: 2, c1: 2, r2: 3, c2: 3 }, 'all');
  });
  expect(node(1, 2).style.borderBottomColor).toBe('transparent'); // blank cell above the box
  expect(node(2, 1).style.borderRightColor).toBe('transparent'); // blank cell left of the box
  expect(node(2, 2).style.borderBottomColor).toBe('transparent'); // inside the box: C4 draws the line
  expect(node(2, 2).style.borderRightColor).toBe('transparent');
  expect(node(3, 3).classList.contains('bt')).toBe(true);
  expect(node(3, 3).classList.contains('bb')).toBe(true); // the box's own bottom edge replaces its gridline
  expect(node(1, 5).style.borderBottomColor).toBe(''); // away from the box the gridlines stay
  expect(node(5, 2).style.borderBottomColor).toBe('');
  grid.destroy();
});
