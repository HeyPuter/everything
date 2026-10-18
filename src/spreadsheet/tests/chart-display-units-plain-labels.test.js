import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData, normalizeChart } from '../src/core/charts.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

// With display units the axis already names its scale; its labels read as plain numbers, not 20K "thousands".
const tickTexts = svg => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(m => m[1]);

it.each([['column', 'yUnits'], ['scatter', 'xUnits']])('writes %s axis labels in display units without K, M or B', (type, key) => {
  const wb = new Workbook();
  const sheet = wb.activeSheet;
  const values = [10e6, 20e6, 30e6];
  sheet.charts.push(normalizeChart({ type, anchor: { r: 0, c: 0 }, range: { r1: 0, c1: 0, r2: 0, c2: 0 }, legend: false,
    sourceRefs: [{ name: 'Sales', literal: type === 'scatter' ? { categories: values, values: [1, 2, 3] } : { categories: ['A', 'B', 'C'], values } }],
    appearance: { [key]: { builtIn: 'thousands', label: 'Thousands' } } }));
  const chart = sheet.charts.at(-1);
  const texts = tickTexts(renderChartSvg(chartData(wb, sheet.id, chart), chart, 600, 400));
  expect(texts).toContain('30,000');
  expect(texts.filter(t => /^-?[\d.,]+[KMBT]$/.test(t))).toEqual([]);
});
