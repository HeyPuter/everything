import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { chartSeriesLine, chartXGridlines } from '../src/core/charts.js';
import { chartStylePatch, CHART_STYLES } from '../src/core/chart-design.js';

// Picking a Chart Style restyles a chart; it must not undo what Format Axis set on its axes.
it.each(CHART_STYLES.map(s => s.id))('keeps the axes\' logarithmic scale, order, bounds and crossing through Chart Style %s', id => {
  const wb = new Workbook(), sheet = wb.activeSheetId;
  [['x', 'y'], ['1', '3'], ['10', '40'], ['100', '900']].forEach((row, r) => row.forEach((v, c) => wb.setInput(sheet, r, c, v)));
  const chartId = wb.addChart(sheet, newExcelChart(wb, sheet, { r1: 0, c1: 0, r2: 3, c2: 1 }, 'scatter'));
  const axes = { yLogBase: 10, xLogBase: 10, reverseValues: true, reverseCategories: true, xMin: 1, xMax: 1000, axisCrossings: { x: 'max' } };
  wb.updateChart(sheet, chartId, { appearance: { ...wb.chartById(sheet, chartId).appearance, ...axes } });
  wb.updateChart(sheet, chartId, chartStylePatch(wb.chartById(sheet, chartId), id, { seriesCount: 1 }));
  expect(wb.chartById(sheet, chartId).appearance).toMatchObject(axes);
});

// A chart in the app's own style keeps its vertical gridlines (Edit chart) and its series' marker sizes and line
// widths (Edit chart, the assistant) on itself. A Chart Style, which gives it Excel's style, dropped them.
it.each(CHART_STYLES.map(s => s.id))('keeps an app-style chart\'s vertical gridlines and marker sizes through Chart Style %s', id => {
  const wb = new Workbook(), sheet = wb.activeSheetId;
  [['x', 'y', 'z'], ['1', '3', '4'], ['10', '40', '5'], ['100', '900', '6']].forEach((row, r) => row.forEach((v, c) => wb.setInput(sheet, r, c, v)));
  const chartId = wb.addChart(sheet, { type: 'scatter', range: { r1: 0, c1: 0, r2: 3, c2: 2 }, anchor: { r: 0, c: 4 }, xGridlines: true,
    seriesLines: [null, { markerSize: 12, width: 4, markerSymbol: 'diamond' }] });
  wb.updateChart(sheet, chartId, chartStylePatch(wb.chartById(sheet, chartId), id, { seriesCount: 2 }));
  const chart = wb.chartById(sheet, chartId);
  expect(chartXGridlines(chart)).toBe(true);
  expect(chartSeriesLine(chart, 1)).toMatchObject({ markerSize: 12, markerSizeUnit: 'pt', width: 4, markerSymbol: 'diamond', marker: true });
  expect(chartSeriesLine(chart, 0).markerSize).toBe(5);
  expect(chart.seriesLines).toBeUndefined();
});
