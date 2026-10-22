import { expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';
import { runChartAction } from '../src/ui/chart-actions.js';

// A waterfall draws its increases, decreases and total in the chart's first three colours. Change Colors gave it a
// palette of one colour, its single series' count, so only the increases took the palette and the decreases and
// the total kept their red and grey beside it. The palette now recolours all three, as in Excel.
it('recolours the increases, decreases and total of a waterfall from the palette picked', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Month', 'Delta'], ['Start', '100'], ['Feb', '-30'], ['Mar', '45']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const cid = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 1 }, 'waterfall'));
  const ctx = { wb, sheetId: () => id, grid: { selectedChart: cid, focus: vi.fn() } };
  runChartAction(ctx, { action: 'colors', colors: ['#111111', '#222222', '#333333', '#444444'] });
  const chart = wb.chartById(id, cid);
  expect(chart.colors.slice(0, 3)).toEqual(['#111111', '#222222', '#333333']);
  const fills = [...renderChartSvg(chartData(wb, id, chart), chart, 480, 288).matchAll(/class="chart-waterfall-bar"[^>]*fill="([^"]+)"/g)].map((m) => m[1]);
  expect(fills).toEqual(['#111111', '#222222', '#111111', '#333333']);
});
