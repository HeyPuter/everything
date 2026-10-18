import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { chartData } from '../src/core/charts.js';

// A chart with series of its own (every chart read from an Excel file, and one edited in Select Data) plots
// its series references, not its range. When a table grew by a row, only the range of a chart on the table's
// own sheet followed it: a chart opened from Excel over the table, here or on a dashboard sheet, went on
// plotting the old rows, and a row typed under the table never reached it. Its series grow with the table now.
const grid = (rows) => rows.flatMap((row, r) => row.map((v, c) => ({ r, c, cell: { v } })));

function book(totalsRow = false) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, grid([['Item', 'Qty'], ['a', 1], ['b', 2], ['c', 3]]));
  const tid = wb.addTable(id, parseRange('A1:B4'), { name: 'Sales', totalsRow });
  const series = (sheet) => [{ nameRef: `${sheet}!$B$1`, categories: `${sheet}!$A$2:$A$4`, values: `${sheet}!$B$2:$B$4` }];
  wb.addChart(id, { type: 'column', range: parseRange('A1:B4'), anchor: { r: 0, c: 4 }, w: 300, h: 200, sourceRefs: series('Sheet1'),
    titleRef: 'Sheet1!$B$4' });
  wb.addSheet('Dashboard');
  const dash = wb.activeSheetId;
  wb.addChart(dash, { type: 'line', range: parseRange('A1:A1'), anchor: { r: 0, c: 0 }, w: 300, h: 200,
    sourceRefs: [...series('Sheet1'), { categories: 'Sheet1!$A$2:$A$3', values: 'Sheet1!$B$2:$B$3' }] });
  wb.setActiveSheet(id);
  wb.clearHistory();
  const plotted = (sheetId) => chartData(wb, sheetId, wb.sheet(sheetId).charts[0]).series.map((s) => s.values);
  return { wb, id, tid, dash, plotted };
}

it('grows the series of charts over a table, on its sheet and on others, as a row is typed under it', () => {
  const { wb, id, dash, plotted } = book();
  expect(plotted(id)).toEqual([[1, 2, 3]]);
  wb.setInput(id, 4, 0, 'd');
  wb.setInput(id, 4, 1, '40');
  expect(wb.tableById(id, wb.sheet(id).tables[0].id).range).toEqual(parseRange('A1:B5'));
  const [own] = wb.sheet(id).charts;
  expect(own.sourceRefs[0]).toMatchObject({ nameRef: 'Sheet1!$B$1', categories: 'Sheet1!$A$2:$A$5', values: 'Sheet1!$B$2:$B$5' });
  // A title read from a cell of the last row is a single cell, not a series: it stays where it is.
  expect(own.titleRef).toBe('Sheet1!$B$4');
  expect(plotted(id)).toEqual([[1, 2, 3, 40]]);
  const [other] = wb.sheet(dash).charts;
  expect(other.sourceRefs[0]).toMatchObject({ categories: 'Sheet1!$A$2:$A$5', values: 'Sheet1!$B$2:$B$5' });
  // A series that ends short of the table's last row is no part of its growth.
  expect(other.sourceRefs[1]).toMatchObject({ categories: 'Sheet1!$A$2:$A$3', values: 'Sheet1!$B$2:$B$3' });
  expect(plotted(dash)[0]).toEqual([1, 2, 3, 40]);
  // Undoing the typing takes the growth back with the table's.
  while (wb.canUndo()) wb.undo();
  expect(wb.sheet(id).charts[0].sourceRefs[0].values).toBe('Sheet1!$B$2:$B$4');
  expect(wb.sheet(dash).charts[0].sourceRefs[0].values).toBe('Sheet1!$B$2:$B$4');
  while (wb.canRedo()) wb.redo();
  expect(wb.sheet(dash).charts[0].sourceRefs[0].values).toBe('Sheet1!$B$2:$B$5');
});

it('grows them when a row is added above a totals row', () => {
  const { wb, id, tid, dash, plotted } = book(true);
  expect(wb.addTableRow(id, tid)).toBe(4);
  expect(wb.sheet(id).charts[0].sourceRefs[0].values).toBe('Sheet1!$B$2:$B$5');
  expect(wb.sheet(dash).charts[0].sourceRefs[0].categories).toBe('Sheet1!$A$2:$A$5');
  wb.setInput(id, 4, 1, '9');
  expect(plotted(dash)[0]).toEqual([1, 2, 3, 9]);
});
