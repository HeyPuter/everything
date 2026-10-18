// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook, DEFAULT_ROW_HEIGHT } from '../src/core/workbook.js';
import { stylesheet, declared } from './helpers/css.js';

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
const TOP = ROW + 5; // the chart's top: anchored at row 1, dy 5
const flush = () => new Promise((r) => setTimeout(r, 5));
const pe = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 2, button: 0, pointerType: 'touch' }));

async function setup() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 0, 0, '1');
  wb.setInput(id, 1, 0, '2');
  const chartId = wb.addChart(id, { type: 'column', range: { r1: 0, c1: 0, r2: 1, c2: 0 }, anchor: { r: 1, c: 2 }, dx: 10, dy: 5, w: 300, h: 200 });
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  // A finger moves only a selected chart (one not selected lets the finger scroll the sheet).
  grid.selectChart(chartId);
  await flush();
  const steps = wb.undoLabels().length;
  return { wb, id, chartId, grid, steps, box: grid.el.querySelector(`.chart-box[data-chart="${chartId}"]`) };
}

// A drag the browser gives up (on touch, every pan the page decided to scroll with) ended as if
// released, moving or resizing the chart by however far the finger had got and adding an undo step.
describe('a chart drag ended by pointercancel', () => {
  it('leaves the chart where it was, with no undo step', async () => {
    const { wb, id, chartId, grid, steps, box } = await setup();
    pe(box, 'pointerdown', 300, 60);
    pe(box, 'pointermove', 312, 60);
    await flush();
    expect(box.style.transform).toBe(`translate(222px, ${TOP}px)`); // the box follows the finger meanwhile
    pe(box, 'pointercancel', 312, 60);
    await flush();
    expect(wb.chartById(id, chartId).dx).toBe(10);
    expect(wb.undoLabels().length).toBe(steps);
    expect(box.style.transform).toBe(`translate(210px, ${TOP}px)`);
    grid.destroy();
  });

  it('leaves the chart its size when the resize corner is let go of', async () => {
    const { wb, id, chartId, grid, steps, box } = await setup();
    const corner = box.querySelector('.chart-resize');
    pe(corner, 'pointerdown', 510, 231);
    pe(box, 'pointermove', 560, 281);
    pe(box, 'pointercancel', 560, 281);
    await flush();
    expect([wb.chartById(id, chartId).w, wb.chartById(id, chartId).h]).toEqual([300, 200]);
    expect(wb.undoLabels().length).toBe(steps);
    grid.destroy();
  });

  it('is not started by the browser for a finger on a selected chart, its corner or a table corner', () => {
    const css = stylesheet('grid.css');
    for (const selector of ['.chart-box.selected', '.chart-resize', '.table-handle']) expect(declared(css, selector, false)['touch-action'], selector).toBe('none');
  });
});
