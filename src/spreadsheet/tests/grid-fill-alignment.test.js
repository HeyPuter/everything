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


async function mount(prepare) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  prepare(wb, id);
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await new Promise((r) => setTimeout(r, 5));
  return { grid, node: (r, c) => grid.el.querySelector(`#gc-${r}-${c}`) };
}

// Fill, one of the horizontal alignments Format Cells offers, was laid out as plain left alignment: a "-" set
// to Fill, Excel's way of drawing a ruling line across a cell, showed as one dash.
describe('Fill alignment', () => {
  it('repeats the entry across its cell as many whole times as fit', async () => {
    const { grid, node } = await mount((wb, id) => {
      wb.setInput(id, 0, 0, '-'); // 7px a character in a 100px column: 100 less 5px of padding and edge
      wb.setInput(id, 1, 0, '7');
      wb.applyStyle(id, { r1: 0, c1: 0, r2: 1, c2: 0 }, { align: 'fill' });
    });
    expect(node(0, 0).textContent).toBe('-'.repeat(13));
    expect(node(1, 0).textContent).toBe('7'.repeat(13));
    grid.destroy();
  });

  it('never runs a long entry over its empty neighbours', async () => {
    const { grid, node } = await mount((wb, id) => {
      wb.setInput(id, 0, 0, 'x'.repeat(40));
      wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { align: 'fill' });
    });
    expect(node(0, 0).classList.contains('spill')).toBe(false);
    expect(node(0, 0).style.width).toBe('100px');
    expect(node(0, 0).textContent).toBe('x'.repeat(40));
    grid.destroy();
  });

  // The cell's text is the entry repeated, which a screen reader read out whole: a 7 set to Fill was read as
  // seven million seven hundred..., a ruling dash as a row of dashes. It is named by the entry it repeats.
  it('names the cell by its entry for a screen reader, not by the repeats', async () => {
    const { grid, node } = await mount((wb, id) => {
      wb.setInput(id, 0, 0, '-');
      wb.setInput(id, 1, 0, '7');
      wb.applyStyle(id, { r1: 0, c1: 0, r2: 1, c2: 0 }, { align: 'fill' });
    });
    expect(node(0, 0).getAttribute('aria-label')).toBe('-');
    expect(node(1, 0).getAttribute('aria-label')).toBe('7');
    grid.destroy();
  });
});
