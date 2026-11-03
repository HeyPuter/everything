import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart, changeSubtypePatch } from '../src/core/chart-subtypes.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

// Change Chart Type keeps the value axis's number format, unit and display units; it dropped its scale.
it.each(['lineMarkers', 'area', 'barClustered', 'columnStacked'])('keeps a logarithmic, reversed value axis when a column chart becomes %s', subtype => {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Year', 'Users'], ['Y1', '3'], ['Y2', '40'], ['Y3', '700'], ['Y4', '9000']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 4, c2: 1 }, 'columnClustered'));
  wb.updateChart(id, chartId, { appearance: { ...wb.chartById(id, chartId).appearance, yLogBase: 10, reverseValues: true } });
  wb.updateChart(id, chartId, changeSubtypePatch(wb.chartById(id, chartId), subtype));
  const chart = wb.chartById(id, chartId);
  expect(chart.appearance).toMatchObject({ yLogBase: 10, reverseValues: true });
  const svg = renderChartSvg(chartData(wb, id, chart), chart, 480, 288);
  expect([...svg.matchAll(/data-el="yAxis"[^>]*>([^<]*)</g)].map(m => m[1])).toEqual(['1', '10', '100', '1,000', '10K']);
});

// Format Axis ▸ Custom values are the value axis's too: Change Chart Type kept its major unit and dropped them.
it.each(['lineMarkers', 'area', 'barClustered'])('keeps the value axis\'s custom tick values when a column chart becomes %s', subtype => {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Year', 'Users'], ['Y1', '3'], ['Y2', '40'], ['Y3', '70'], ['Y4', '90']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 4, c2: 1 }, 'columnClustered'));
  wb.updateChart(id, chartId, { appearance: { ...wb.chartById(id, chartId).appearance, yTickValues: [0, 25, 50, 100] } });
  wb.updateChart(id, chartId, changeSubtypePatch(wb.chartById(id, chartId), subtype));
  const chart = wb.chartById(id, chartId);
  expect(chart.appearance.yTickValues).toEqual([0, 25, 50, 100]);
  const svg = renderChartSvg(chartData(wb, id, chart), chart, 480, 288);
  expect([...svg.matchAll(/data-el="yAxis"[^>]*>([^<]*)</g)].map(m => m[1])).toEqual(['0', '25', '50', '100']);
});

// Format Axis' Box around plot area belongs to the axes as well: Change Chart Type gave the new type its own axis
// lines and dropped the box, though a plot area's own border came through.
it.each(['lineMarkers', 'barClustered', 'scatter'])('keeps the box around the plot area when a column chart becomes %s', subtype => {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Year', 'Users'], ['1', '3'], ['2', '40'], ['3', '70']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 1 }, 'columnClustered'));
  const a = wb.chartById(id, chartId).appearance;
  wb.updateChart(id, chartId, { appearance: { ...a, axisStyles: { ...a.axisStyles, x: { ...a.axisStyles.x, box: true, color: '#ff0000', width: 2 }, y: { ...a.axisStyles.y, box: true, color: '#595959' } } } });
  wb.updateChart(id, chartId, changeSubtypePatch(wb.chartById(id, chartId), subtype));
  const chart = wb.chartById(id, chartId);
  expect(chart.appearance.axisStyles.x).toMatchObject({ box: true, color: '#ff0000', width: 2 });
  expect(chart.appearance.axisStyles.y).toMatchObject({ box: true, color: '#595959' });
  const svg = renderChartSvg(chartData(wb, id, chart), chart, 480, 288);
  expect(svg.match(/class="chart-axis-box/g)).toHaveLength(4);
});
