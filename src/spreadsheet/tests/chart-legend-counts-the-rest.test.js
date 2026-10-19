import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

function draw(subtype, rows, extra = {}) {
  const wb = new Workbook(), id = wb.activeSheetId;
  rows.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  const chartId = wb.addChart(id, { ...newExcelChart(wb, id, { r1: 0, c1: 0, r2: rows.length - 1, c2: rows[0].length - 1 }, subtype), ...extra });
  const chart = wb.chartById(id, chartId);
  return renderChartSvg(chartData(wb, id, chart), chart, 480, 288);
}
const slices = k => [['Item', 'Share'], ...Array.from({ length: k }, (_, i) => [`Category ${i + 1}`, 40 - i])];
const series = k => [['Month', ...Array.from({ length: k }, (_, j) => `Series ${j + 1}`)],
  ...Array.from({ length: 20 }, (_, r) => [`M${r + 1}`, ...Array.from({ length: k }, (_, j) => (j + 1) * (r + 2))])];
const legendText = svg => [...svg.matchAll(/class="chart-legend-label"[^>]*>([^<]*)</g)].map(m => m[1]);

it.each(['pie', 'doughnut'])('a %s of fifteen slices names eleven and counts the other four in its legend', subtype => {
  const names = legendText(draw(subtype, slices(15)));
  expect(names.slice(0, 11)).toEqual(Array.from({ length: 11 }, (_, i) => `Category ${i + 1}`));
  expect(names.at(-1)).toBe('…and 4 more');
  expect(names).toHaveLength(12);
});

it.each(['lineMarkers', 'columnClustered', 'areaStacked'])('a %s chart of fifteen series counts the series its legend leaves out', subtype => {
  const svg = draw(subtype, series(15));
  const names = legendText(svg);
  expect(names.at(-1)).toBe('…and 4 more');
  expect(names).toContain('Series 11');
  expect(names).not.toContain('Series 12');
  expect(svg).not.toMatch(/NaN|undefined/);
});

it('a treemap of fifteen branches counts the ones its legend leaves out', () => {
  const rows = [['Branch', 'Leaf', 'Size'], ...Array.from({ length: 15 }, (_, i) => [`Branch ${i + 1}`, `Leaf ${i + 1}`, 30 - i])];
  expect(legendText(draw('treemap', rows, { legend: true })).at(-1)).toBe('…and 4 more');
});

it('a legend of twelve or fewer names every entry', () => {
  const names = legendText(draw('pie', slices(12)));
  expect(names).toHaveLength(12);
  expect(names.at(-1)).toBe('Category 12');
});

it('a radar chart of fifteen series counts the series its legend leaves out', () => {
  const svg = draw('radarMarkers', series(15), { legend: true });
  expect(svg).toContain('>…and 4 more<');
  expect(svg).not.toMatch(/NaN|undefined/);
});
