import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData, normalizeChart } from '../src/core/charts.js';
import { axisFraction } from '../src/core/chart-axis-scale.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

// Data near ±9e307 rounds out to an axis of -1e308 to 1e308, whose span is past the largest double.
const rows = [['Item', 'North', 'South'], [9e307, 9e307, 4.5e307], [-9e307, -9e307, -4.5e307], [1, 1, 2]];
function inserted(subtype) {
  const wb = new Workbook(), id = wb.activeSheetId;
  rows.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  const chart = normalizeChart(newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 2 }, subtype));
  return renderChartSvg(chartData(wb, id, chart), chart, 480, 300);
}
const finite = svg => expect(svg.match(/NaN|Infinity/g)).toBeNull();
const data = { categories: ['a', 'b', 'c'], series: [{ name: 'v', values: [9e307, -9e307, 1] }] };

describe('an axis spanning more than a double holds', () => {
  it('measures values along it in finite fractions, and normal axes as before', () => {
    expect(axisFraction(9e307, -1e308, 1e308)).toBeCloseTo(0.95, 12);
    expect(axisFraction(-9e307, -1e308, 1e308)).toBeCloseTo(0.05, 12);
    expect(axisFraction(0, -1e308, 1e308)).toBe(0.5);
    expect(axisFraction(3, 2, 6)).toBe(0.25);
    expect(axisFraction(5, 5, 5)).toBe(0);
  });

  it.each(['columnClustered', 'barClustered', 'lineMarkers', 'area', 'scatter', 'radarMarkers', 'surface3d'])('draws an inserted %s chart at finite coordinates', subtype => {
    finite(inserted(subtype));
  });

  it('draws an app-style radar chart and a secondary axis at finite coordinates', () => {
    finite(renderChartSvg(data, { type: 'radar', legend: true }, 480, 300));
    // A value just short of the largest double stays on the radar's rings instead of overflowing the radius.
    finite(renderChartSvg({ ...data, series: [{ name: 'v', values: [9e307, 1, 3] }] }, { type: 'radar', legend: true }, 480, 300));
    const extreme = { categories: ['a', 'b', 'c'], series: [{ name: 'v', values: [1, 2, 3] }, { name: 'w', values: [1.7e308, -1.7e308, 0] }] };
    finite(renderChartSvg(extreme, { type: 'combo', secondaryAxis: true, legend: true }, 480, 300));
  });
});
