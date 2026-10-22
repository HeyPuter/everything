import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { chartStylePatch, elementFormatPatch } from '../src/core/chart-design.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

// A waterfall made from Insert ▸ Charts carries the default style's appearance, as every new chart does, but was
// drawn by the app's older renderer, which reads none of it: the Format pane's title size and colour, the chart
// and plot area fills, the axis text, Chart Styles and point colours all changed nothing on it, and none of its
// bars or axes could be picked to format. It is drawn in its appearance now, as the histogram already was.
function waterfall() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Month', 'Delta'], ['Start', '100'], ['Feb', '-30'], ['Mar', '45']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const cid = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 1 }, 'waterfall'));
  const chart = () => wb.chartById(id, cid);
  const patch = (p) => wb.updateChart(id, cid, p);
  const draw = () => renderChartSvg(chartData(wb, id, chart()), chart(), 480, 288);
  return { chart, patch, draw };
}

it('draws a default-style waterfall in its own fonts, fills and colours', () => {
  const { chart, patch, draw } = waterfall();
  const a = chart().appearance;
  patch({ appearance: { ...a, titleStyle: { ...a.titleStyle, size: 30, color: '#ff0000' }, background: '#00ff00', xStyle: { ...a.xStyle, color: '#0000ff' } } });
  patch(elementFormatPatch(chart(), 'plotArea', { fill: '#abcdef' }));
  patch(elementFormatPatch(chart(), 'point:0:1', { fill: '#123456' }));
  const svg = draw();
  expect(svg).toMatch(/font-size="30"[^>]*fill="#ff0000"[^>]*data-el="title"/);
  expect(svg).toContain('fill="#00ff00"');
  expect(svg).toMatch(/data-el="plotArea"[^>]*fill="#abcdef"/);
  expect(svg).toMatch(/fill="#0000ff"[^>]*data-el="xAxis">Start</);
  // Each bar, the total among them, can be picked; the one coloured on its own keeps its colour.
  const bars = [...svg.matchAll(/<rect class="chart-waterfall-bar"[^>]*fill="([^"]+)"[^>]*data-point="(\d)"/g)].map((m) => [m[2], m[1]]);
  expect(bars.map(([i]) => i)).toEqual(['0', '1', '2', '3']);
  expect(bars[1][1]).toBe('#123456');
  expect(svg).toContain('>Total</text>');
});

it('takes a chart style and keeps its labels and legend', () => {
  const { chart, patch, draw } = waterfall();
  patch({ ...chartStylePatch(chart(), 2, { seriesCount: 1 }) });
  patch({ labels: true, legend: true });
  const svg = draw();
  expect(svg).toContain('>+100</text>');
  expect(svg).toContain('>−30</text>');
  expect(svg).toContain('>115</text>');
  expect([...svg.matchAll(/class="chart-legend-label">([^<]+)</g)].map((m) => m[1])).toEqual(['Increase', 'Decrease', 'Total']);
});

it('leaves a waterfall in the app\'s own style as it was drawn', () => {
  const { chart, patch, draw } = waterfall();
  patch({ appearance: undefined });
  expect(chart().appearance).toBeUndefined();
  expect(draw()).not.toContain('chart-waterfall-bar');
});

it('keeps its data table, a column for each bar and the total', () => {
  const { chart, patch, draw } = waterfall();
  patch({ appearance: { ...chart().appearance, dataTable: { horizontal: true, vertical: true, outline: true, keys: false } } });
  const svg = draw();
  expect(svg).toContain('class="chart-data-table"');
  const cells = [...svg.matchAll(/role="cell"><title>([^<]*)<\/title>/g)].map((m) => m[1]);
  expect(cells).toEqual(['Start', 'Feb', 'Mar', 'Total', 'Delta', '100', '-30', '45', '115']);
  // The table names the bars, so the axis below them carries no labels of its own.
  expect(svg).not.toMatch(/data-el="xAxis">Start</);
});
