import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { chartElementPatch } from '../src/core/chart-design.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

function make(subtype) {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Item', 'Amount'], ['a', '12'], ['b', '-5'], ['c', '30'], ['d', '18'], ['e', '7'], ['f', '25']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 6, c2: 1 }, subtype));
  const element = (name, value) => wb.updateChart(id, chartId, chartElementPatch(wb.chartById(id, chartId), name, value));
  const draw = () => { const chart = wb.chartById(id, chartId); return renderChartSvg(chartData(wb, id, chart), chart, 480, 288); };
  return { element, draw };
}
// Value labels sit right-aligned left of the plot; category labels centred under it. A histogram is drawn in the
// default style (its labels named by data-el), a waterfall by the app's own renderer.
const valueLabels = svg => (svg.match(/data-el="yAxis"|text-anchor="end" font-size="11" fill="var\(--ink-3\)"/g) || []).length;
const categoryLabels = svg => (svg.match(/<text[^>]*data-el="xAxis"|text-anchor="middle" font-size="11" fill="var\(--ink-2\)"/g) || []).length;

// Add Chart Element ▸ Axes and ▸ Gridlines ▸ Vertical on a histogram or waterfall were ticked and drew no change.
it.each(['histogram', 'waterfall'])('deletes the axes of a %s chart and draws its vertical gridlines', subtype => {
  const { element, draw } = make(subtype);
  const before = draw();
  expect(valueLabels(before)).toBeGreaterThan(0);
  expect(categoryLabels(before)).toBeGreaterThan(0);
  expect(before).not.toMatch(/chart-gridline-x"/);
  element('axes', { axis: 'vertical', on: false });
  expect(valueLabels(draw())).toBe(0);
  expect(categoryLabels(draw())).toBe(categoryLabels(before));
  element('axes', { axis: 'horizontal', on: false });
  expect(categoryLabels(draw())).toBe(0);
  element('gridlines', { axis: 'vertical', on: true });
  expect((draw().match(/chart-gridline-x"/g) || []).length).toBeGreaterThan(2);
});
