import { expect, it } from 'vitest';
import { normalizeChart, defaultChart } from '../src/core/charts.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

const chart = (extra = {}) => normalizeChart({ ...defaultChart({ r1: 0, c1: 0, r2: 1, c2: 1 }, { r: 0, c: 0 }), type: 'boxWhisker', ...extra });
const boxes = svg => (svg.match(/<g class="chart-box" /g) || []).length;
// A named row each (an id or a name column before the scores): every row is a group of its own.
function named(rows, cols) {
  return { categories: Array.from({ length: rows }, (_, i) => `Person ${i + 1}`), hasHeaders: true,
    sourceLayout: { categoryLine: 0 },
    series: Array.from({ length: cols }, (_, j) => ({ name: `Test ${j + 1}`, values: Array.from({ length: rows }, (_, i) => Math.round(Math.sin(i / 40 + j) * 50 + 50)) })) };
}

it('draws a box & whisker chart of thousands of named rows at the plot\'s width, not a box per row', () => {
  const svg = renderChartSvg(named(4999, 10), chart(), 480, 288);
  expect(boxes(svg)).toBeGreaterThan(100);
  expect(boxes(svg)).toBeLessThanOrEqual(480);
  expect(svg.length).toBeLessThan(1_000_000);
  expect(svg).not.toMatch(/NaN|Infinity/);
});

it('keeps every box of a chart with room for them', () => {
  const svg = renderChartSvg(named(12, 3), chart(), 480, 288);
  expect(boxes(svg)).toBe(36);
});

it('shares the points shown inside many boxes', () => {
  const data = { categories: Array.from({ length: 6000 }, (_, i) => `G${i % 60}`), hasHeaders: true, sourceLayout: { categoryLine: 0 },
    series: Array.from({ length: 4 }, (_, j) => ({ name: `S${j}`, values: Array.from({ length: 6000 }, (_, i) => (i * 7 + j) % 101) })) };
  const svg = renderChartSvg(data, chart({ box: { quartiles: 'exclusive', innerPoints: true, outliers: true, meanMarkers: true, meanLine: false, gapWidth: 100 } }), 640, 360);
  expect(boxes(svg)).toBe(240);
  expect((svg.match(/chart-box-point/g) || []).length).toBeLessThanOrEqual(8000);
  expect((svg.match(/chart-box-point/g) || []).length).toBeGreaterThan(4000);
  expect(svg.length).toBeLessThan(2_000_000);
});
