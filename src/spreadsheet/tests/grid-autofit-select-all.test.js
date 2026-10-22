// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/** Count the entries walked by for-of over any Map while `fn` runs. */
function mapStepsDuring(fn) {
  const orig = Map.prototype[Symbol.iterator];
  let steps = 0;
  Map.prototype[Symbol.iterator] = function () {
    const it = orig.call(this);
    return { next: () => { const r = it.next(); if (!r.done) steps++; return r; }, [Symbol.iterator]() { return this; } };
  };
  try { fn(); } finally { Map.prototype[Symbol.iterator] = orig; }
  return steps;
}

// With the whole sheet selected, a double-click on a column's edge fitted all 16,384 columns one by one, each
// walking the sheet's cells (ten seconds for 20,000 cells), and shrank every empty column to a 40px sliver.
// Format > Fit columns already left empty columns as they were.
describe('fitting every column after Select All', () => {
  it('fits the columns that hold something, quickly, and leaves the empty ones their width', async () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    for (let r = 0; r < 300; r++) for (let c = 0; c < 3; c++) wb.setInput(id, r, c, `${'x'.repeat(c + 1)}${r}`);
    wb.setColWidth(id, 6, 150);
    const grid = createGrid({ wb, sheetId: id });
    document.body.replaceChildren(grid.el);
    await flush();
    grid.selectByName('A1:XFD1048576');
    await flush();
    const steps = mapStepsDuring(() => grid.el.querySelector('.col-resizer[data-c="1"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(wb.colWidth(id, 0)).toBe(4 * 7 + 14); // x299
    expect(wb.colWidth(id, 2)).toBe(6 * 7 + 14); // xxx299
    expect(wb.colWidth(id, 6)).toBe(150);
    expect(wb.colWidth(id, 10)).toBe(wb.sheet(id).defaultColWidth);
    expect(steps).toBeLessThan(wb.sheet(id).cells.size * 10);
    grid.destroy();
  });

  it('leaves a lone empty column its width when its edge is double-clicked', async () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    wb.setColWidth(id, 3, 150);
    const grid = createGrid({ wb, sheetId: id });
    document.body.replaceChildren(grid.el);
    await flush();
    grid.el.querySelector('.col-resizer[data-c="3"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(wb.colWidth(id, 3)).toBe(150);
    grid.destroy();
  });
});
