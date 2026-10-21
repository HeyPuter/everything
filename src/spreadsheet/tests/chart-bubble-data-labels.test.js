import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { chartElementPatch } from '../src/core/chart-design.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

// Add Chart Element ▸ Data Labels ▸ Show on a bubble chart made here ticked Show and drew no labels,
// though the file it saved showed each bubble's value.
it('labels each bubble with its value when data labels are turned on', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['x', 'y', 'size'], ['1', '20', '5'], ['2', '45', '3'], ['3', '30', '8']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 2 }, 'bubble'));
  const render = () => { const chart = wb.chartById(id, chartId); return renderChartSvg(chartData(wb, id, chart), chart, 480, 288); };
  const labels = svg => [...svg.matchAll(/class="chart-data-label"[^>]*>([^<]*)</g)].map(m => m[1]);
  expect(labels(render())).toEqual([]);
  wb.updateChart(id, chartId, chartElementPatch(wb.chartById(id, chartId), 'dataLabels', 'show', { seriesCount: 1 }));
  const svg = render();
  expect(labels(svg)).toEqual(['20', '45', '30']);
  // Each sits in its bubble's centre.
  const centres = [...svg.matchAll(/class="chart-bubble" cx="([\d.]+)"/g)].map(m => +m[1]);
  const xs = [...svg.matchAll(/<text x="([\d.]+)"[^>]*class="chart-data-label"/g)].map(m => +m[1]);
  xs.forEach((x, i) => expect(x).toBeCloseTo(centres[i], 1));
  wb.updateChart(id, chartId, chartElementPatch(wb.chartById(id, chartId), 'dataLabels', 'none', { seriesCount: 1 }));
  expect(labels(render())).toEqual([]);
});
