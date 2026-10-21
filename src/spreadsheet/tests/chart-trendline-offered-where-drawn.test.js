import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { chartElementPatch, chartElementState } from '../src/core/chart-design.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

function make(subtype) {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['k', 'a', 'b'], ['x', '1', '2'], ['y', '4', '5'], ['z', '7', '3']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 2 }, subtype));
  return { wb, id, chart: () => wb.chartById(id, chartId) };
}

// Add Chart Element ▸ Trendline ▸ Linear ticked Linear on these and drew nothing: Excel offers none for them.
it.each(['radar', 'radarMarkers', 'radarFilled', 'histogram', 'waterfall'])('offers no trendline on a %s chart', subtype => {
  const { chart } = make(subtype);
  expect(chartElementPatch(chart(), 'trendline', 'linear')).toBeNull();
  expect(chartElementState(chart()).trendline).toBe('none');
});

it.each(['columnClustered', 'barClustered', 'lineMarkers', 'area', 'scatter'])('still draws the trendline it offers on a %s chart', subtype => {
  const { wb, id, chart } = make(subtype);
  wb.updateChart(id, chart().id, chartElementPatch(chart(), 'trendline', 'linear'));
  expect(renderChartSvg(chartData(wb, id, chart()), chart(), 480, 288)).toMatch(/stroke-dasharray="5 4"/);
});
