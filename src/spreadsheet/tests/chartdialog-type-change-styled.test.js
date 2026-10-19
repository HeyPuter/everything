// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart, subtypeOf } from '../src/core/chart-subtypes.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';
import { openChartDialog } from '../src/ui/chartdialog.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: true })); document.body.innerHTML = '<div id="app"></div>'; });
afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function setup(rows = [['x', 'y', 'size'], ['1', '10', '4'], ['2', '20', '16'], ['3', '15', '1']]) {
  const wb = new Workbook(), id = wb.activeSheetId;
  rows.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: rows.length - 1, c2: rows[0].length - 1 }, 'columnClustered'));
  const chart = () => wb.chartById(id, chartId);
  const open = () => openChartDialog({ wb, sheetId: () => id, range: () => chart().range, grid: { focus: vi.fn(), selectChart: vi.fn() } }, { chart: chart() });
  const save = () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Save').click();
  const svg = () => renderChartSvg(chartData(wb, id, chart()), chart(), chart().w, chart().h);
  return { chart, open, save, svg };
}

it('turns a chart in Excel\'s style into a bubble chart that draws bubbles', () => {
  const { chart, open, save, svg } = setup();
  open();
  document.querySelector('[data-type="bubble"]').click();
  expect(document.querySelector('.chart-preview').innerHTML).toMatch(/<circle/);
  save();
  expect(chart().type).toBe('bubble');
  expect(subtypeOf(chart())).toBe('bubble');
  expect((svg().match(/<circle /g) || []).length).toBeGreaterThanOrEqual(3);
});

it('turns it into a scatter chart of markers, not lines', () => {
  const { chart, open, save, svg } = setup();
  open();
  document.querySelector('[data-type="scatter"]').click();
  save();
  expect(subtypeOf(chart())).toBe('scatter');
  expect(svg()).not.toMatch(/<path class="chart-series[^"]*" d="M[^"]*L/);
});

it('keeps the chart\'s own look when its type is picked again', () => {
  const { chart, open, save } = setup();
  const before = JSON.stringify(chart().appearance);
  open();
  document.querySelector('[data-type="pie"]').click();
  document.querySelector('[data-type="column"]').click();
  save();
  expect(JSON.stringify(chart().appearance)).toBe(before);
});
