// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { detachedChart } from '../src/core/chart-design.js';

// A chart with references of its own (every chart in an Excel file) read all of its points again after
// any edit anywhere in the workbook: on a dashboard of imported charts over a few thousand rows each
// keystroke cost tens of milliseconds a chart. Writes away from the ranges a chart reads now leave it
// alone; writes into them, and changes reaching ranges that hold formulas, still redraw it.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
const flush = () => new Promise((r) => setTimeout(r, 5));

async function setup(formula = false) {
  const wb = new Workbook({ sheets: [{ name: 'Data' }, { name: 'Other' }] });
  const id = wb.sheets[0].id, other = wb.sheets[1].id;
  [['Item', 'Sales'], ['Pens', '3'], ['Ink', '4'], ['Paper', formula ? '=Z1*2' : '5']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  wb.setInput(id, 0, 25, '1');
  const chart = wb.addChart(id, { ...detachedChart(wb, id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 1 }, 'columnClustered')), anchor: { r: 6, c: 0 } });
  expect(wb.chartById(id, chart).sourceRefs[0].values).toBe('Data!$B$2:$B$4');
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  const node = () => grid.el.querySelector(`.chart-box[data-chart="${chart}"] .chart-body`);
  // A drawing names its clip path afresh each time: compared without it.
  const body = () => node().innerHTML.replace(/chart-plot-\w+/g, 'clip');
  // The cells are painted by the grid as well; a chart's reading resolves its references.
  const lookups = vi.spyOn(wb, 'rangeFromText');
  const pointsRead = () => lookups.mock.calls.filter(([, ref]) => ref === 'Data!$B$2:$B$4').length;
  return { wb, id, other, grid, body, node, pointsRead };
}

it('leaves a chart alone when cells away from its ranges are written', async () => {
  const { wb, id, other, grid, body, node, pointsRead } = await setup();
  const before = body(), drawing = node().firstElementChild;
  wb.setInput(id, 20, 8, 'elsewhere'); wb.setInput(other, 1, 1, '9');
  await flush();
  expect(pointsRead()).toBe(0);
  expect(node().firstElementChild).toBe(drawing);
  wb.setInput(id, 2, 1, '40');
  await flush();
  expect(pointsRead()).toBeGreaterThan(0);
  expect(body()).not.toBe(before);
  grid.destroy();
});

it('still redraws a chart whose ranges hold formulas when their inputs change elsewhere', async () => {
  const { wb, id, grid, body } = await setup(true);
  const before = body();
  wb.setInput(id, 0, 25, '50');
  await flush();
  expect(body()).not.toBe(before);
  grid.destroy();
});

it('redraws after rows are hidden and after an edit is undone', async () => {
  const { wb, id, grid, body } = await setup();
  const before = body();
  wb.setInput(id, 3, 1, '90');
  await flush();
  const edited = body();
  expect(edited).not.toBe(before);
  wb.undo();
  await flush();
  expect(body()).toBe(before);
  wb.setHidden(id, 'row', [2], true);
  await flush();
  expect(body()).not.toBe(before);
  grid.destroy();
});
