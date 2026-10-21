import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { chartElementPatch } from '../src/core/chart-design.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

const DATA = {
  boxWhisker: [['Group', 'Score'], ['A', '3'], ['A', '5'], ['A', '9'], ['B', '4'], ['B', '7'], ['B', '12']],
  stockHlc: [['Date', 'High', 'Low', 'Close'], ['1/1/2024', '5', '3', '4'], ['1/2/2024', '6', '2', '5'], ['1/3/2024', '7', '4', '6']],
  contour: [['', 'a', 'b', 'c'], ['x', '1', '2', '3'], ['y', '4', '5', '6'], ['z', '7', '8', '9']],
};

// Add Chart Element ▸ Axis Titles on a box and whisker, stock or surface chart was ticked and drew nothing.
it.each(Object.keys(DATA))('draws the axis titles of a %s chart beside its plot', subtype => {
  const rows = DATA[subtype], wb = new Workbook(), id = wb.activeSheetId;
  rows.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: rows.length - 1, c2: rows[0].length - 1 }, subtype));
  for (const axis of ['horizontal', 'vertical']) wb.updateChart(id, chartId, chartElementPatch(wb.chartById(id, chartId), 'axisTitles', { axis, on: true }));
  wb.updateChart(id, chartId, { xTitle: 'Period', yTitle: 'Price' });
  const chart = wb.chartById(id, chartId), svg = renderChartSvg(chartData(wb, id, chart), chart, 480, 288);
  const x = svg.match(/<text x="([\d.]+)" y="([\d.]+)"[^>]*data-el="xTitle"[^>]*>Period</), y = svg.match(/<text x="([\d.]+)" y="([\d.]+)"[^>]*data-el="yTitle" transform="rotate\(-90[^>]*>Price</);
  expect(x).toBeTruthy();
  expect(y).toBeTruthy();
  // The vertical title lies left of every value label and the horizontal one below every category label.
  const labels = [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*class="chart-axis-label/g)].map(m => [+m[1], +m[2]]);
  for (const [lx, ly] of labels) { expect(+x[2]).toBeGreaterThan(ly); expect(+y[1]).toBeLessThan(lx); }
  if (subtype !== 'contour') expect(labels.length).toBeGreaterThan(0);
  expect(svg).not.toMatch(/NaN|Infinity/);
});
