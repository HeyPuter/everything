// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { changeSubtypePatch, newExcelChart } from '../src/core/chart-subtypes.js';
import { workbookToXlsx } from '../src/core/io.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

afterEach(() => vi.unstubAllGlobals());
const chartXml = async wb => {
  vi.stubGlobal('Blob', NodeBlob);
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  return new TextDecoder().decode(zip.FileIndex[zip.FullPaths.findIndex(p => /\/charts\/chart[^/]*\.xml$/.test(p))].content);
};

// A line or area chart with a trendline, turned into a stacked one by Change Chart Type, kept drawing its trendlines
// through each series' own values while the series stood on one another, and Format Trendline and the Delete key
// (which take no trendline on a stack) could not take them off.
it.each([['line', 'lineStacked'], ['area', 'areaStacked'], ['columnClustered', 'columnStacked']])('draws and saves no trendline once a %s chart is stacked', async (from, to) => {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Month', 'North', 'South'], ['Jan', '5', '3'], ['Feb', '50', '20'], ['Mar', '500', '100']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, { ...newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 2 }, from), trendline: true, trendlines: [{ type: 'linear', dispEq: true }] });
  const svg = () => { const chart = wb.chartById(id, chartId); return renderChartSvg(chartData(wb, id, chart), chart, 480, 300); };
  expect(svg()).toContain('class="chart-trendline"');
  wb.updateChart(id, chartId, changeSubtypePatch(wb.chartById(id, chartId), to));
  expect(wb.chartById(id, chartId).stacked).toBe(true);
  expect(svg()).not.toContain('chart-trendline');
  expect(await chartXml(wb)).not.toContain('<c:trendline>');
  // Unstacked again, the chart draws the trendline it kept.
  wb.updateChart(id, chartId, changeSubtypePatch(wb.chartById(id, chartId), from));
  expect(svg()).toContain('class="chart-trendline"');
});

it('keeps the trendline of a combo chart\'s line beside stacked columns', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Month', 'North', 'South', 'Total'], ['Jan', '5', '3', '8'], ['Feb', '50', '20', '70'], ['Mar', '500', '100', '600']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, { ...newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 3 }, 'comboColumnLine'), stacked: true, trendline: true });
  const chart = wb.chartById(id, chartId);
  const svg = renderChartSvg(chartData(wb, id, chart), chart, 480, 300);
  expect(svg.match(/class="chart-trendline"/g)).toHaveLength(1);
});
