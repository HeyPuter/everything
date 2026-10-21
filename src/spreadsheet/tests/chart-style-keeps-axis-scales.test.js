import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
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
