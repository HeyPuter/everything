import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';

// A chart reads its data straight from a range of cells. Dragging one column of that data elsewhere (or
// cutting and pasting it), or cutting the whole of it to another sheet, left the chart reading the cells the
// data had left: its series went blank, or its header row turned into a category. The chart's series now
// follow their cells, as in Excel: a move that takes only part of the range, or takes it to another sheet,
// gives the chart its series as references first, and those follow the cells moved.
function book() {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Month', 'Sales', 'Cost'], ['Jan', '10', '4'], ['Feb', '20', '6'], ['Mar', '30', '8']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 2 }, 'columnClustered'));
  return { wb, id, chartId, read: () => chartData(wb, wb.sheets.find((s) => s.charts.some((c) => c.id === chartId)).id, wb.chartById(id, chartId)) };
}
const shape = (data) => ({ categories: data.categories, series: data.series.map((s) => [s.name, s.values]) });
const expected = { categories: ['Jan', 'Feb', 'Mar'], series: [['Sales', [10, 20, 30]], ['Cost', [4, 6, 8]]] };

it('keeps a series whose column was dragged away from the rest of the data', () => {
  const { wb, id, read } = book();
  expect(shape(read())).toEqual(expected);
  wb.moveRange(id, { r1: 0, c1: 2, r2: 3, c2: 2 }, 0, 6); // Cost to G
  expect(shape(read())).toEqual(expected);
  wb.undo();
  expect(shape(read())).toEqual(expected);
  expect(wb.chartById(id, wb.sheet(id).charts[0].id).sourceRefs).toBeUndefined();
});

it('keeps the series of data cut whole to another sheet', () => {
  const { wb, id, chartId, read } = book();
  const other = wb.addSheet('Data').id;
  const cells = wb.copyRange(id, { r1: 0, c1: 0, r2: 3, c2: 2 });
  wb.placeMoved(other, 4, 1, cells, { sheetId: id, range: { r1: 0, c1: 0, r2: 3, c2: 2 }, all: true });
  expect(wb.getCell(id, 1, 1)).toBeFalsy();
  expect(shape(chartData(wb, id, wb.chartById(id, chartId)))).toEqual(expected);
  expect(wb.chartById(id, chartId).sourceRefs[0].values).toBe('Data!$C$6:$C$8');
});

it('still shifts a chart whose whole range is dragged within its sheet', () => {
  const { wb, id, chartId, read } = book();
  wb.moveRange(id, { r1: 0, c1: 0, r2: 3, c2: 2 }, 10, 4);
  expect(shape(read())).toEqual(expected);
  expect(wb.chartById(id, chartId)).toMatchObject({ range: { r1: 10, c1: 4, r2: 13, c2: 6 } });
  expect(wb.chartById(id, chartId).sourceRefs).toBeUndefined();
});
