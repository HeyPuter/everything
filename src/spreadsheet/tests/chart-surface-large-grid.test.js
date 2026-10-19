import { expect, it } from 'vitest';
import { normalizeChart, defaultChart } from '../src/core/charts.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

const chart = (surfaceView) => normalizeChart({ ...defaultChart({ r1: 0, c1: 0, r2: 1, c2: 1 }, { r: 0, c: 0 }), type: 'surface', surfaceView, legend: false });
// A ridge of 100 along the first series (the front edge of a 3-D surface), 0 everywhere else.
function grid(rows, cols) {
  return { categories: Array.from({ length: rows }, (_, i) => `r${i}`),
    series: Array.from({ length: cols }, (_, j) => ({ name: `c${j}`, values: Array.from({ length: rows }, () => (j === 0 ? 100 : 0)) })) };
}
const band = (svg, k) => (svg.match(new RegExp(`<polygon [^>]*data-series="${k}"`, 'g')) || []).length;

it('draws the front of a large 3-D surface', () => {
  const small = renderChartSvg(grid(20, 10), chart('surface3d'), 640, 400);
  const top = Math.max(...[...small.matchAll(/data-series="(\d+)"/g)].map(m => +m[1]));
  expect(band(small, top)).toBeGreaterThan(0);
  const large = renderChartSvg(grid(150, 60), chart('surface3d'), 640, 400);
  expect(band(large, top)).toBeGreaterThan(0);
  expect(large.length).toBeLessThan(2_000_000);
  expect(large).not.toMatch(/NaN|Infinity/);
});

it('keeps a surface of thousands of rows to a picture the page can draw', () => {
  for (const view of ['surface3d', 'contour', 'wireframe3d', 'wireframeContour']) {
    const svg = renderChartSvg(grid(5000, 10), chart(view), 640, 400);
    expect(svg.length, view).toBeLessThan(2_000_000);
    expect(svg).toContain('>r0<');
  }
});

it('names every k-th series up the side of a contour chart rather than running the names together', () => {
  const labels = svg => [...svg.matchAll(/class="chart-axis-label"[^>]*>(c\d+)</g)].map(m => m[1]);
  const many = labels(renderChartSvg(grid(30, 40), chart('contour'), 480, 288));
  expect(many[0]).toBe('c0');
  expect(many.length).toBeGreaterThan(4);
  expect(many.length).toBeLessThan(20);
  expect(labels(renderChartSvg(grid(30, 6), chart('contour'), 480, 288))).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
});
