import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

// A scatter chart's x labels are centred on their ticks, and the last tick lies on the plot's right edge. The
// plot ran nearly to the chart's edge, so half of the last label hung over it and was cut off: a scatter of
// prices by date ended its axis in "4/18/20". The plot now leaves room for the outer labels, as Excel's does.
function scatterLabels(w, h, reverse = false) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const cells = [{ r: 0, c: 0, cell: { v: 'Date' } }, { r: 0, c: 1, cell: { v: 'Price' } }];
  for (let i = 0; i < 30; i++) {
    cells.push({ r: i + 1, c: 0, cell: { v: 45292 + i * 3, s: { fmt: 'custom', code: 'm/d/yyyy' } } }, { r: i + 1, c: 1, cell: { v: 100 + i } });
  }
  wb.setCells(id, cells);
  const made = newExcelChart(wb, id, { r1: 0, c1: 0, r2: 30, c2: 1 }, 'scatter');
  const cid = wb.addChart(id, { ...made, w, h, appearance: { ...made.appearance, reverseCategories: reverse } });
  const chart = wb.chartById(id, cid);
  const svg = renderChartSvg(chartData(wb, id, chart), chart, w, h);
  return [...svg.matchAll(/<text x="([\d.]+)"[^>]*data-el="xAxis"[^>]*>([^<]*)</g)].map((m) => ({ x: Number(m[1]), text: m[2] }));
}
// Calibri's digits and slashes are about half an em wide; the labels are 12 pixels.
const half = (text) => (text.length * 12 * 0.5) / 2;

it('keeps the last date on a scatter chart inside the chart', () => {
  const labels = scatterLabels(420, 260);
  expect(labels.at(-1).text).toBe('4/18/2024');
  for (const { x, text } of labels) {
    expect(x + half(text)).toBeLessThanOrEqual(420);
    expect(x - half(text)).toBeGreaterThanOrEqual(0);
  }
});

it('keeps the outer labels inside when the axis runs right to left', () => {
  const labels = scatterLabels(420, 260, true);
  const rightmost = labels.reduce((a, b) => (b.x > a.x ? b : a));
  expect(rightmost.x + half(rightmost.text)).toBeLessThanOrEqual(420);
});
