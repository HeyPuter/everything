import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';

// Excel reads a blank top-left cell as the mark of a table with labels on both sides: the first row names
// the series and the first column the categories, even when those are numbers. A column of years under an
// empty corner was plotted as a series of its own (2020, 2021, 2022 as bars towering over the data) with
// the categories numbered 1, 2, 3. The years now label the categories, as in Excel.
function chartOver(rows, type = 'columnClustered') {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, rows.flatMap((row, r) => row.map((v, c) => ({ r, c, cell: { v } }))));
  return chartData(wb, id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: rows.length - 1, c2: rows[0].length - 1 }, type));
}

it('takes years under a blank corner for the categories', () => {
  const data = chartOver([[null, 'Sales', 'Cost'], [2020, 5, 3], [2021, 7, 4], [2022, 9, 6]]);
  expect(data.categories).toEqual(['2020', '2021', '2022']);
  expect(data.series.map((s) => [s.name, s.values])).toEqual([['Sales', [5, 7, 9]], ['Cost', [3, 4, 6]]]);
});

it('takes numbers across the top under a blank corner for the series names', () => {
  const data = chartOver([[null, 2024, 2025], ['North', 5, 6], ['South', 7, 8], ['East', 1, 2]]);
  expect(data.categories).toEqual(['North', 'South', 'East']);
  expect(data.series.map((s) => [s.name, s.values])).toEqual([['2024', [5, 7, 1]], ['2025', [6, 8, 2]]]);
});

it('leaves a filled corner and a scatter chart as they were', () => {
  const years = chartOver([['Year', 'Sales'], [2020, 5], [2021, 7]]);
  expect(years.categories).toEqual(['1', '2']);
  expect(years.series.map((s) => s.name)).toEqual(['Year', 'Sales']);
  const scatter = chartOver([[null, 'y'], [1, 2], [3, 4]], 'scatter');
  expect(scatter.x).toEqual([1, 3]);
  expect(scatter.series.map((s) => [s.name, s.values])).toEqual([['y', [2, 4]]]);
});

it('does not take an error in the corner for a blank one', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '=NA()');
  [['Sales'], ['5'], ['7']].forEach(([v], r) => wb.setInput(id, r, 1, v));
  wb.setInput(id, 1, 0, '2020'); wb.setInput(id, 2, 0, '2021');
  const data = chartData(wb, id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 2, c2: 1 }));
  expect(data.categories).toEqual(['1', '2']);
});
