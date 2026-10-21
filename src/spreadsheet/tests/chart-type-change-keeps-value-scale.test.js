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
