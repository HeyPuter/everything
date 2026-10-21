import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { chartElementPatch } from '../src/core/chart-design.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

// Add Chart Element ▸ Trendline ▸ Linear on a chart in the default style.
function render(subtype) {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Month', 'Sales'], ['Jan', '10'], ['Feb', '20'], ['Mar', '30'], ['Apr', '40']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 4, c2: 1 }, subtype));
  // A stacked chart offers no trendline; one comes with it from a file.
  wb.updateChart(id, chartId, chartElementPatch(wb.chartById(id, chartId), 'trendline', 'linear') || { trendline: true });
  const chart = wb.chartById(id, chartId);
  return renderChartSvg(chartData(wb, id, chart), chart, 480, 288);
}
const trend = svg => svg.match(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"[^>]*stroke-dasharray="5 4"/)?.slice(1).map(Number) || null;
const bars = svg => [...svg.matchAll(/class="chart-series chart-(?:column|bar)" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map(m => m.slice(1).map(Number));

it('draws the trendline of a column chart through the tops of its columns', () => {
  const svg = render('columnClustered');
  const line = trend(svg), cols = bars(svg);
  expect(line).not.toBeNull();
  const [first, last] = [cols[0], cols.at(-1)];
  expect(line[0]).toBeCloseTo(first[0] + first[2] / 2, 1);
  expect(line[1]).toBeCloseTo(first[1], 1);
  expect(line[2]).toBeCloseTo(last[0] + last[2] / 2, 1);
  expect(line[3]).toBeCloseTo(last[1], 1);
});

it('draws the trendline of a bar chart down its categories, through the ends of its bars', () => {
  const svg = render('barClustered');
  const line = trend(svg), rows = bars(svg);
  expect(line).not.toBeNull();
  // The first category's bar lies lowest; the line runs from its end up to the last, longest bar's.
  const [first, last] = [rows[0], rows.at(-1)];
  expect(line[0]).toBeCloseTo(first[0] + first[2], 1);
  expect(line[1]).toBeCloseTo(first[1] + first[3] / 2, 1);
  expect(line[2]).toBeCloseTo(last[0] + last[2], 1);
  expect(line[3]).toBeCloseTo(last[1] + last[3] / 2, 1);
});

it('draws no trendline on a stacked column chart, as Excel offers none', () => {
  expect(trend(render('columnStacked'))).toBeNull();
});
