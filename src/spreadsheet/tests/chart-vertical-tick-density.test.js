import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { Workbook } from '../src/core/workbook.js';
import { chartData, normalizeChart } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

// A chart made small (a dashboard tile, a chart dragged down to its corner) kept the major unit of a
// full-size one up its value axes: 0, 5, 10 … 50 in a plot under a hundred pixels tall, the labels
// written over each other. An automatic unit now widens until the labels have room, as Excel's does
// and as the horizontal value axis of a bar chart already did; units set by hand stay.
function labels(subtype, width, height, patch = {}) {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Month', 'Sales', 'Margin'], ['Jan', '12', '0.31'], ['Feb', '38', '0.12'], ['Mar', '27', '0.22'], ['Apr', '45', '0.4']]
    .forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const made = newExcelChart(wb, id, { r1: 0, c1: 0, r2: 4, c2: 2 }, subtype);
  const chart = normalizeChart({ ...made, id: 'c', ...patch, appearance: { ...made.appearance, ...patch.appearance } });
  const doc = new JSDOM(renderChartSvg(chartData(wb, id, chart), chart, width, height)).window.document;
  const read = (el) => [...doc.querySelectorAll(`text[data-el="${el}"]`)].map(n => ({ text: n.textContent, y: +n.getAttribute('y'), size: +n.getAttribute('font-size') || 12 }));
  return { y: read('yAxis'), y2: read('y2Axis') };
}
const roomy = (list) => list.every((l, i) => i === 0 || Math.abs(l.y - list[i - 1].y) >= l.size);

it.each(['columnClustered', 'line', 'areaStacked', 'scatter'])('spaces the value labels of a small %s chart', subtype => {
  const { y } = labels(subtype, 240, 160);
  expect(y.length).toBeGreaterThanOrEqual(3);
  expect(roomy(y)).toBe(true);
});

it('spaces the secondary axis labels of a small combo chart', () => {
  const { y, y2 } = labels('comboColumnLineSecondary', 240, 160);
  expect(y2.length).toBeGreaterThanOrEqual(3);
  expect(roomy(y)).toBe(true);
  expect(roomy(y2)).toBe(true);
});

it('keeps the full-size chart’s unit, and a unit set by hand', () => {
  expect(labels('columnClustered', 480, 288).y.map(l => l.text)).toEqual(['0', '5', '10', '15', '20', '25', '30', '35', '40', '45', '50']);
  expect(labels('columnClustered', 240, 160, { appearance: { yStep: 5 } }).y).toHaveLength(11);
});
