// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

async function mount(prepare) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  for (let r = 0; r < 30; r++) for (let c = 0; c < 10; c++) wb.setInput(id, r, c, String(r + c));
  prepare(wb, id);
  const spy = vi.spyOn(wb, 'conditionalStyle');
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await new Promise((r) => setTimeout(r, 5));
  return { grid, spy, node: (r, c) => grid.el.querySelector(`#gc-${r}-${c}`) };
}

// Each cell drops its gridline under a border the cell below or beside it draws, so it reads those neighbours'
// borders. The read evaluated every conditional formatting rule over again for each of them, though a rule that
// sets no border cannot draw one: on a sheet coloured by rules, a fifth more time went into every scroll frame.
it('reads the neighbours\' borders without evaluating rules that set none', async () => {
  const { grid, spy } = await mount((wb, id) => {
    wb.addRule(id, { range: { r1: 0, c1: 0, r2: 29, c2: 9 }, type: 'gt', value: 10, style: { bg: '#ffc7ce' } });
  });
  const cells = grid.el.querySelectorAll('.cell').length;
  expect(cells).toBeGreaterThan(0);
  // One evaluation per cell drawn, as it paints the cell; not more for the cells around it.
  expect(spy.mock.calls.length).toBeLessThanOrEqual(cells);
  grid.destroy();
});

it('still drops the gridline beside a border a rule draws', async () => {
  const { grid, node } = await mount((wb, id) => {
    wb.addRule(id, { range: { r1: 3, c1: 2, r2: 3, c2: 2 }, type: 'gt', value: 0, style: { bt: true, btBorder: { bs: 'thin', bc: '#000000' } } });
  });
  expect(node(3, 2).classList.contains('bt')).toBe(true);
  expect(node(2, 2).style.borderBottomColor).toBe('transparent');
  expect(node(2, 3).style.borderBottomColor).toBe('');
  grid.destroy();
});
