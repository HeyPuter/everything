import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { chartElementPatch } from '../src/core/chart-design.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

function make(subtype) {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['', 'North', 'South', 'East'], ['Jan', '1', '2', '3'], ['Feb', '4', '5', '6'], ['Mar', '7', '8', '9']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 3 }, subtype));
  const chart = () => wb.chartById(id, chartId);
  return { chart, draw: () => renderChartSvg(chartData(wb, id, chart()), chart(), 480, 288), set: patch => wb.updateChart(id, chartId, patch) };
}

// Add Chart Element offered these on a surface and ticked them, but nothing was drawn: Excel offers none of them.
it.each(['surface3d', 'surfaceWireframe3d', 'contour', 'contourWireframe'])('offers no data labels or vertical gridlines on a %s chart', subtype => {
  const { chart } = make(subtype);
  expect(chartElementPatch(chart(), 'dataLabels', 'show')).toBeNull();
  expect(chartElementPatch(chart(), 'gridlines', { axis: 'vertical', on: true })).toBeNull();
  expect(chartElementPatch(chart(), 'gridlines', { axis: 'horizontal', on: false }) === null).toBe(subtype.startsWith('contour'));
});

it('deletes a contour chart\'s vertical axis, the series names up its side', () => {
  const { chart, draw, set } = make('contour');
  const names = svg => ['North', 'South', 'East'].filter(n => svg.includes(`>${n}</text>`) && new RegExp(`text-anchor="end"[^>]*class="chart-axis-label">${n}<`).test(svg));
  expect(names(draw())).toEqual(['North', 'South', 'East']);
  set(chartElementPatch(chart(), 'axes', { axis: 'vertical', on: false }));
  expect(names(draw())).toEqual([]);
  // The categories along the foot stay.
  expect(draw()).toMatch(/class="chart-axis-label">Jan</);
});
