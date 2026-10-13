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

describe('overlapping charts', () => {
  it('are drawn in the sheet\'s stacking order whatever is selected, and Bring to Front changes it without moving nodes', async () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    const under = wb.addChart(id, { type: 'column', range: { r1: 0, c1: 0, r2: 1, c2: 1 }, anchor: { r: 1, c: 2 }, w: 300, h: 200 });
    const over = wb.addChart(id, { type: 'column', range: { r1: 0, c1: 0, r2: 1, c2: 1 }, anchor: { r: 2, c: 3 }, w: 300, h: 200 });
    const grid = createGrid({ wb, sheetId: id });
    document.body.replaceChildren(grid.el);
    await flush();
    const boxes = () => [...grid.el.querySelectorAll('.chart-box')];
    const [first, second] = boxes();
    expect(first.dataset.chart).toBe(under);
    expect(Number(second.style.zIndex)).toBeGreaterThan(Number(first.style.zIndex));
    // Selecting the one beneath shows its frame but leaves the order the sheet keeps (Arrange decides it).
    grid.selectChart(under);
    await flush();
    expect(Number(second.style.zIndex)).toBeGreaterThan(Number(first.style.zIndex));
    expect(first.classList.contains('selected')).toBe(true);
    wb.orderObjects(id, [under], 'front');
    await flush();
    expect(Number(first.style.zIndex)).toBeGreaterThan(Number(second.style.zIndex));
    // The node stays where it was in the DOM, so the press that selected it can still become a double-click.
    expect(boxes()).toEqual([first, second]);
    wb.undo();
    await flush();
    expect(Number(second.style.zIndex)).toBeGreaterThan(Number(first.style.zIndex));
    grid.destroy();
  });
});
