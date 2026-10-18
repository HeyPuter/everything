import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { Workbook } from '../src/core/workbook.js';
import { chartData, normalizeChart } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { quickLayoutPatch, chartElementPatch } from '../src/core/chart-design.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

// With the legend at the right or turned off (Quick Layout 6 and 7, or Add Chart Element ▸ Axis Titles on a
// chart without a bottom legend), the horizontal axis title was written on the line of the category labels
// ("Q2 2024Axis TitleQ3 2024"): nothing kept room for it under the labels. The plot now leaves that room.
function drawn(subtype, patchOf) {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Quarter', 'Revenue', 'Costs'], ['Q1 2024', '1200', '800'], ['Q2 2024', '1500', '950'], ['Q3 2024', '900', '700'], ['Q4 2024', '1800', '1100']]
    .forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const made = normalizeChart({ ...newExcelChart(wb, id, { r1: 0, c1: 0, r2: 4, c2: 2 }, subtype), id: 'c' });
  const chart = normalizeChart({ ...made, ...patchOf(made) });
  const doc = new JSDOM(renderChartSvg(chartData(wb, id, chart), chart, 480, 288)).window.document;
  const ys = (el) => [...doc.querySelectorAll(`text[data-el="${el}"]`)].map((n) => +n.getAttribute('y'));
  return { title: ys('xTitle'), labels: ys('xAxis'), size: +doc.querySelector('text[data-el="xTitle"]').getAttribute('font-size') };
}

it.each([
  ['columnClustered', 'Quick Layout 6', (c) => quickLayoutPatch(c, 6, { seriesCount: 2 })],
  ['line', 'Quick Layout 7', (c) => quickLayoutPatch(c, 7, { seriesCount: 2 })],
  ['columnClustered', 'an axis title with no legend', (c) => ({ ...chartElementPatch(c, 'axisTitles', { axis: 'horizontal', on: true }), legend: false })],
])('puts the %s horizontal axis title under its category labels (%s)', (subtype, _, patchOf) => {
  const { title, labels, size } = drawn(subtype, patchOf);
  expect(title).toHaveLength(1);
  expect(labels.length).toBeGreaterThan(0);
  expect(title[0] - Math.max(...labels)).toBeGreaterThanOrEqual(size);
});
