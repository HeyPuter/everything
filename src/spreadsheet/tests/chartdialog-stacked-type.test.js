// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { trendlineAllowed } from '../src/core/chart-design.js';
import { openChartDialog } from '../src/ui/chartdialog.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: true })); document.body.innerHTML = '<div id="app"></div>'; });
afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function edit(chartOf) {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Month', 'North', 'South'], ['1', '5', '3'], ['2', '50', '20'], ['3', '500', '100']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, chartOf(wb, id, { r1: 0, c1: 0, r2: 3, c2: 2 }));
  const save = type => {
    openChartDialog({ wb, sheetId: () => id, range: () => wb.chartById(id, chartId).range, grid: { focus: vi.fn(), selectChart: vi.fn() } }, { chart: wb.chartById(id, chartId) });
    if (type) document.querySelector(`[data-type="${type}"]`).click();
    document.querySelector('form').requestSubmit();
    vi.runAllTimers();
    return wb.chartById(id, chartId);
  };
  return { save };
}

// Edit chart's Stacked boxes are hidden for a type it offers no stacking for, but what they held still went on the
// chart: a stacked column chart made a Line chart came out as a stacked line chart, and one made a Scatter chart
// kept a stack that turned its trendlines away.
it.each([['line', 'line'], ['scatter', 'scatter'], ['pie', 'pie']])('gives a stacked column chart made a %s chart no stack', (type) => {
  for (const chartOf of [(wb, id, range) => newExcelChart(wb, id, range, 'columnStacked100'), (wb, id, range) => ({ type: 'column', stacked: true, stack100: true, range, anchor: { r: 6, c: 0 } })]) {
    const chart = edit(chartOf).save(type);
    expect(chart.type).toBe(type);
    expect(chart.stacked).toBe(false);
    expect(chart.stack100).toBe(false);
    if (type !== 'pie') expect(trendlineAllowed(chart)).toBe(true);
  }
});

it('keeps the stack of a chart whose type stacks, its boxes shown or not', () => {
  expect(edit((wb, id, range) => newExcelChart(wb, id, range, 'lineStacked100')).save(null)).toMatchObject({ type: 'line', stacked: true, stack100: true });
  expect(edit((wb, id, range) => newExcelChart(wb, id, range, 'columnStacked')).save('bar')).toMatchObject({ type: 'bar', stacked: true, stack100: false });
});
