import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { chartElementPatch } from '../src/core/chart-design.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

const DATA = {
  boxWhisker: [['Group', 'Score'], ['A', '3'], ['A', '5'], ['A', '9'], ['B', '4'], ['B', '7'], ['B', '12'], ['C', '2'], ['C', '6']],
  stockHlc: [['Date', 'High', 'Low', 'Close'], ['1/1/2024', '5', '3', '4'], ['1/2/2024', '6', '2', '5'], ['1/3/2024', '7', '4', '6']],
};

// Add Chart Element ▸ Gridlines ▸ Vertical on a box and whisker or stock chart was ticked and drew nothing.
it.each(Object.keys(DATA))('draws vertical gridlines between the categories of a %s chart', subtype => {
  const rows = DATA[subtype], wb = new Workbook(), id = wb.activeSheetId;
  rows.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: rows.length - 1, c2: rows[0].length - 1 }, subtype));
  const draw = () => { const chart = wb.chartById(id, chartId); return renderChartSvg(chartData(wb, id, chart), chart, 480, 288); };
  const lines = svg => [...svg.matchAll(/class="chart-gridline chart-gridline-x" x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g)].map(m => m.slice(1).map(Number));
  expect(lines(draw())).toEqual([]);
  wb.updateChart(id, chartId, chartElementPatch(wb.chartById(id, chartId), 'gridlines', { axis: 'vertical', on: true }));
  const found = lines(draw());
  // Three categories: a line at each edge of each slot, evenly spaced and upright.
  expect(found).toHaveLength(4);
  for (const [x1, , x2] of found) expect(x1).toBe(x2);
  const gaps = found.slice(1).map((l, i) => l[0] - found[i][0]);
  for (const g of gaps) expect(g).toBeCloseTo(gaps[0], 1);
});
