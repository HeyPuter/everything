import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

// An area chart has no gaps to leave: Excel draws an empty cell (or a word) in an area series as zero, the
// band dropping to the axis there. The area was cut at each empty cell instead, and a value with empty cells
// on both sides made a band of no width: Q1 below, 100 · empty · n/a · -50, drew nothing at all, plain or
// stacked, though its legend entry was there.
const parser = new (new JSDOM('').window.DOMParser)();
function draw(subtype) {
  const wb = new Workbook(), id = wb.sheets[0].id;
  [['Region', 'Q1', 'Q2'], ['North', 100, -20], ['South', '', 35], ['East', 'n/a', 40], ['West', -50, 0]]
    .forEach((row, r) => row.forEach((v, c) => { if (v !== '') wb.setInput(id, r, c, String(v)); }));
  const chart = newExcelChart(wb, id, { r1: 0, c1: 0, r2: 4, c2: 2 }, subtype);
  const doc = parser.parseFromString(renderChartSvg(chartData(wb, id, chart), chart, 480, 288), 'image/svg+xml');
  return [...doc.querySelectorAll('.chart-area')].map(n => ({ series: n.getAttribute('data-series'),
    points: (n.getAttribute('d').match(/[ML] [-\d.]+ [-\d.]+/g) || []).length }));
}

it.each(['area', 'areaStacked', 'areaStacked100'])('draws an empty cell in a %s series as zero, so the band is there', subtype => {
  const areas = draw(subtype);
  const q1 = areas.filter(a => a.series === '0');
  expect(q1).toHaveLength(1);
  expect(q1[0].points).toBeGreaterThanOrEqual(5); // four along the top, and back along the bottom
  expect(areas.filter(a => a.series === '1')).toHaveLength(1);
});
