// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { chartAreas, newExcelChart } from '../src/core/chart-subtypes.js';
import { detachedChart } from '../src/core/chart-design.js';
import { insertChart, insertChartSheet } from '../src/ui/chart-actions.js';

// Ranges selected together (Month, then Ctrl-click Total, skipping the columns between) could not be charted:
// Insert ▸ Chart and Alt+F1 said "Select one range", and the Insert ▸ Column gallery charted the last range
// alone. They chart together now, as in Excel: the labels of the first and a series for each column selected.
function book() {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Month', 'North', 'South', 'Total'], ['Jan', 1, 2, 3], ['Feb', 4, 5, 9], ['Mar', 6, 1, 7]]
    .forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  return { wb, id };
}
const A = { r1: 0, c1: 0, r2: 3, c2: 0 }, B = { r1: 0, c1: 1, r2: 3, c2: 1 }, D = { r1: 0, c1: 3, r2: 3, c2: 3 };
const ctxOf = (wb, id, ranges) => ({ wb, sheetId: () => id, range: () => ranges.at(-1), ranges: () => ranges, dataRange: r => r,
  grid: { selectChart() {}, placeInView: () => null } });

it('charts the labels of one range and the series of another over the same rows', () => {
  const { wb, id } = book();
  const chart = wb.chartById(id, insertChart(ctxOf(wb, id, [A, D]), 'columnClustered'));
  const data = chartData(wb, id, chart);
  expect(data.categories).toEqual(['Jan', 'Feb', 'Mar']);
  expect(data.series.map(s => [s.name, s.values])).toEqual([['Total', [3, 9, 7]]]);
  expect(chart.title).toBe('Total');
  expect(chart.anchor).toEqual({ r: 0, c: 4 });
  // The chart follows its cells as any chart does.
  wb.setInput(id, 1, 3, '10');
  expect(chartData(wb, id, wb.chartById(id, chart.id)).series[0].values).toEqual([10, 9, 7]);
});

it('keeps each selected column a series in the order of the sheet, wherever the selection began', () => {
  const { wb, id } = book();
  const chart = wb.chartById(id, insertChart(ctxOf(wb, id, [D, A, B]), 'lineMarkers'));
  expect(chartData(wb, id, chart).series.map(s => s.name)).toEqual(['North', 'Total']);
  expect(chart.legend).toBe(true);
});

it('charts rows selected together over the same columns, and a chart sheet of them', () => {
  const { wb, id } = book();
  const ranges = [{ r1: 0, c1: 0, r2: 0, c2: 3 }, { r1: 2, c1: 0, r2: 2, c2: 3 }];
  const chart = newExcelChart(wb, id, ranges, 'columnClustered');
  const data = chartData(wb, id, chart);
  expect(data.categories).toEqual(['North', 'South', 'Total']);
  expect(data.series.map(s => [s.name, s.values])).toEqual([['Feb', [4, 5, 9]]]);
  const sheet = insertChartSheet(ctxOf(wb, id, ranges));
  const onSheet = sheet.charts[0];
  expect(chartData(wb, sheet.id, detachedChart(wb, sheet.id, onSheet)).series.map(s => s.name)).toEqual(['Feb']);
});

it('refuses ranges that do not line up', () => {
  expect(chartAreas([A, { r1: 1, c1: 3, r2: 3, c2: 3 }])).toBeNull();
  const { wb, id } = book();
  expect(insertChart(ctxOf(wb, id, [A, { r1: 1, c1: 3, r2: 3, c2: 3 }]))).toBeNull();
  expect(wb.sheet(id).charts).toHaveLength(0);
});

it('charts whole columns selected together as far as their data goes', () => {
  const { wb, id } = book();
  const ranges = [{ r1: 0, c1: 0, r2: 1048575, c2: 0 }, { r1: 0, c1: 3, r2: 1048575, c2: 3 }];
  const chart = wb.chartById(id, insertChart(ctxOf(wb, id, ranges), 'columnClustered'));
  expect(chartData(wb, id, chart).series.map(s => [s.name, s.values])).toEqual([['Total', [3, 9, 7]]]);
});
