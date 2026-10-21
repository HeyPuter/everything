import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { chartElementPatch } from '../src/core/chart-design.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

function legendKeys(subtype, position) {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Month', 'Sales', 'Cost'], ['Jan', '120', '80'], ['Feb', '150', '90']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 2, c2: 2 }, subtype));
  wb.updateChart(id, chartId, chartElementPatch(wb.chartById(id, chartId), 'legend', position));
  const chart = wb.chartById(id, chartId);
  const legend = renderChartSvg(chartData(wb, id, chart), chart, 480, 288).match(/<g data-el="legend"[\s\S]*?<\/g>/)[0];
  return [...legend.matchAll(/<rect x="[\d.]+" y="[\d.]+" width="([\d.]+)" height="([\d.]+)"/g)].map(m => [+m[1], +m[2]]);
}

// Legend keys of columns are the same small squares down the right as along the bottom, not 26 px bars.
it.each(['columnClustered', 'area'])('draws %s legend keys at the right as squares, as at the bottom', subtype => {
  const right = legendKeys(subtype, 'right'), bottom = legendKeys(subtype, 'bottom');
  expect(right).toHaveLength(2);
  for (const [w, h] of right) expect(w).toBeCloseTo(h, 5);
  expect(right[0][0]).toBeCloseTo(bottom[0][0], 1);
});
