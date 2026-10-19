import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

function draw(subtype, rows, extra = {}, W = 480, H = 288) {
  const wb = new Workbook(), id = wb.activeSheetId;
  rows.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  const chartId = wb.addChart(id, { ...newExcelChart(wb, id, { r1: 0, c1: 0, r2: rows.length - 1, c2: rows[0].length - 1 }, subtype), legend: true, legendPos: 'right', ...extra });
  const chart = wb.chartById(id, chartId);
  return renderChartSvg(chartData(wb, id, chart), chart, W, H);
}
const slices = k => [['Item', 'Share'], ...Array.from({ length: k }, (_, i) => [`Category ${i + 1}`, 40 - i])];
const series = k => [['Month', ...Array.from({ length: k }, (_, j) => `Series ${j + 1}`)],
  ...Array.from({ length: 20 }, (_, r) => [`M${r + 1}`, ...Array.from({ length: k }, (_, j) => (j + 1) * (r + 2))])];
// The legend's names: the text drawn right of the plot (x past three quarters of the chart).
const legend = (svg, W = 480) => [...svg.matchAll(/<text [^>]*x="([\d.]+)" y="([\d.]+)"[^>]*>([^<]*)</g)]
  .filter(m => +m[1] > W * .75 && /^(Category|Series|…and)/.test(m[3])).map(m => ({ y: +m[2], text: m[3] }));

it.each([['pie', slices(12)], ['pie', slices(15)], ['lineMarkers', series(12)], ['columnClustered', series(15)]])(
  'a %s chart\'s legend down the right keeps to the chart and counts the entries left out', (subtype, rows) => {
    const entries = legend(draw(subtype, rows));
    expect(entries.length).toBeGreaterThan(5);
    expect(Math.max(...entries.map(e => e.y))).toBeLessThanOrEqual(288 - 4);
    expect(entries.at(-1).text).toMatch(/^…and \d+ more$/);
    const counted = Number(entries.at(-1).text.match(/\d+/)[0]);
    expect(entries.length - 1 + counted).toBe(rows[0].length > 2 ? rows[0].length - 1 : rows.length - 1);
  });

it('a short legend down the right names every entry', () => {
  const entries = legend(draw('pie', slices(6)));
  expect(entries.map(e => e.text)).toEqual(Array.from({ length: 6 }, (_, i) => `Category ${i + 1}`));
});
