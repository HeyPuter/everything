import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

function histogram(patch = a => ({})) {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Minutes');
  [12, 15, 18, 22, 25, 28, 31, 33, 35, 36, 44, 47, 52, 61, 81].forEach((v, i) => wb.setInput(id, i + 1, 0, String(v)));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 15, c2: 0 }, 'histogram'));
  const chart = wb.chartById(id, chartId);
  wb.updateChart(id, chartId, patch(chart.appearance));
  const next = wb.chartById(id, chartId);
  return renderChartSvg(chartData(wb, id, next), next, 480, 288);
}
const columns = svg => [...svg.matchAll(/class="chart-series chart-column" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map(m => m.slice(1).map(Number));

// A histogram made here carries the default style, but was drawn in the app's own look: the Format pane's
// fonts, number formats and axis options, and the chart's own title size, changed nothing on it.
it('draws a histogram in its own style, its axis text and title as formatted', () => {
  const svg = histogram(a => ({ appearance: { ...a, yStyle: { ...a.yStyle, size: 16, color: '#c00000' }, titleStyle: { ...a.titleStyle, size: 24 }, yFormat: '0.0' } }));
  expect(svg).toMatch(/data-el="title"[^>]*>Minutes</);
  expect(svg).toMatch(/font-size="24"[^>]*data-el="title"/);
  const values = [...svg.matchAll(/<text[^>]*font-size="16"[^>]*fill="#c00000"[^>]*data-el="yAxis"[^>]*>([^<]*)</g)].map(m => m[1]);
  expect(values.length).toBeGreaterThan(2);
  expect(values.every(v => /^\d+\.\d$/.test(v))).toBe(true);
});

it('still counts the values into bins whose columns nearly touch', () => {
  const bars = columns(histogram());
  expect(bars.map(b => b[3] > 0)).toEqual(bars.map(() => true));
  // 15 values in bins of 20: 3, 7, 3, 1, 1 — heights in proportion to the counts.
  const unit = bars[0][3] / 3;
  expect(bars.map(b => Math.round(b[3] / unit))).toEqual([3, 7, 3, 1, 1]);
  const gap = bars[1][0] - (bars[0][0] + bars[0][2]);
  expect(gap).toBeLessThan(bars[0][2] * .1);
});

it('deletes its value axis and reverses its values from the Format pane', () => {
  const svg = histogram(a => ({ appearance: { ...a, hideYAxis: true } }));
  expect(svg).not.toMatch(/data-el="yAxis"/);
  const flipped = columns(histogram(a => ({ appearance: { ...a, reverseValues: true } })));
  const upright = columns(histogram());
  expect(flipped[0][1]).toBeLessThan(upright[0][1]);
});
