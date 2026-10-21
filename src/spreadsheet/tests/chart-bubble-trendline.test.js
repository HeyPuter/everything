import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { chartElementPatch } from '../src/core/chart-design.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';
import { workbookToXlsx } from '../src/core/io.js';

afterEach(() => vi.unstubAllGlobals());

// Add Chart Element ▸ Trendline ▸ Linear on a bubble chart, which Excel offers, ticked Linear and drew nothing.
function bubbles() {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['x', 'y', 'size'], ['1', '2', '5'], ['2', '4', '3'], ['3', '6', '8'], ['4', '8', '2']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 4, c2: 2 }, 'bubble'));
  wb.updateChart(id, chartId, chartElementPatch(wb.chartById(id, chartId), 'trendline', 'linear'));
  return { wb, id, chart: wb.chartById(id, chartId) };
}

it('draws a bubble chart\'s trendline through the centres of its bubbles', () => {
  const { wb, id, chart } = bubbles();
  const svg = renderChartSvg(chartData(wb, id, chart), chart, 480, 288);
  const line = svg.match(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"[^>]*stroke-dasharray="5 4"/)?.slice(1).map(Number);
  expect(line).toBeTruthy();
  const centres = [...svg.matchAll(/class="chart-bubble" cx="([\d.]+)" cy="([\d.]+)"/g)].map(m => [+m[1], +m[2]]);
  // y = 2x exactly: the line runs from the first bubble's centre to the last's.
  expect(line[0]).toBeCloseTo(centres[0][0], 1); expect(line[1]).toBeCloseTo(centres[0][1], 1);
  expect(line[2]).toBeCloseTo(centres.at(-1)[0], 1); expect(line[3]).toBeCloseTo(centres.at(-1)[1], 1);
});

it('saves a bubble chart\'s trendline to the workbook file', async () => {
  vi.stubGlobal('Blob', NodeBlob);
  const { wb } = bubbles();
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  const xml = new TextDecoder().decode(zip.FileIndex[zip.FullPaths.findIndex(p => /\/charts\/chart[^/]*\.xml$/.test(p))].content);
  expect(xml).toMatch(/<c:bubbleChart>[\s\S]*<c:trendline><c:trendlineType val="linear"\/><\/c:trendline>[\s\S]*<c:xVal>/);
});
