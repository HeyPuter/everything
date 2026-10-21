import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { quickLayoutPatch } from '../src/core/chart-design.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

const ROWS = [['Item', 'Share'], ['Rent', '1200'], ['Food', '450'], ['Transport', '120'], ['Phone', '40'], ['Internet', '35'], ['Gym', '30'],
  ['Books', '12'], ['Coffee', '25'], ['Gifts', '8'], ['Misc', '5'], ['Charity', '3'], ['Fees', '2']];

// Quick Layout 1 labels each slice with its name and share at Best Fit: the labels of a dozen thin slices were all
// set inside their slices, piled on one another at the top of the pie where none could be read.
it('sets the labels of thin slices outside the pie, one under another, and keeps the labels that fit inside', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  ROWS.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: ROWS.length - 1, c2: 1 }, 'pie'));
  wb.updateChart(id, chartId, quickLayoutPatch(wb.chartById(id, chartId), 1, { seriesCount: 12 }));
  const chart = wb.chartById(id, chartId), svg = renderChartSvg(chartData(wb, id, chart), chart, 480, 288);
  const labels = [...svg.matchAll(/<text class="chart-data-label" x="([\d.]+)" y="([\d.]+)" text-anchor="(\w+)"[^>]*font-size="([\d.]+)"[\s\S]*?>([^<]+)<\/tspan>/g)]
    .map(m => ({ x: +m[1], y: +m[2], anchor: m[3], size: +m[4], text: m[5] }));
  expect(labels).toHaveLength(12);
  // Rent and Food fit in their slices, centred there; the ten thin slices' labels stand outside on leader lines.
  expect(labels.filter(l => l.anchor === 'middle').map(l => l.text).sort()).toEqual(['Food, 23%', 'Rent, 62%']);
  const outside = labels.filter(l => l.anchor !== 'middle');
  expect(outside).toHaveLength(10);
  expect((svg.match(/<path d="M [\d.]+ [\d.]+ L [\d.]+ [\d.]+" fill="none"/g) || []).length).toBe(10);
  for (const anchor of ['start', 'end']) {
    const column = outside.filter(l => l.anchor === anchor).sort((p, q) => p.y - q.y);
    for (let k = 1; k < column.length; k++) expect(column[k].y - column[k - 1].y).toBeGreaterThanOrEqual(column[k].size * 1.2 - 1e-6);
  }
  // None runs above the plot into the title.
  const title = +svg.match(/<text data-el="title" x="[\d.]+" y="([\d.]+)"/)[1];
  for (const l of outside) expect(l.y).toBeGreaterThan(title);
});
