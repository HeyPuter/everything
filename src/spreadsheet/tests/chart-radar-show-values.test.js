import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

// Edit Chart's "Show values" turns a chart's labels on without the per-series label settings
// Add Chart Element ▸ Data Labels writes.
it.each(['radar', 'radarMarkers', 'radarFilled'])('draws a %s chart with Show values ticked in Edit Chart', subtype => {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Skill', 'Ann', 'Bob'], ['Speed', '3', '4'], ['Power', '5', '2'], ['Stamina', '2', '5']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 2 }, subtype));
  wb.updateChart(id, chartId, { labels: true });
  const chart = wb.chartById(id, chartId);
  const svg = renderChartSvg(chartData(wb, id, chart), chart, 480, 288);
  const labels = [...svg.matchAll(/class="chart-data-label"[^>]*>([^<]*)</g)].map(m => m[1]);
  expect(labels).toEqual(['3', '5', '2', '4', '2', '5']);
});
