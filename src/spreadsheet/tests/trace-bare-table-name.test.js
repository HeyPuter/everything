import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// A table named on its own in a formula, as in VLOOKUP(A1,Prices,2,FALSE), was left out of Trace Precedents and
// Trace Dependents: only defined names were looked up, so the arrows missed the most common way to read a table.
function book() {
  const wb = new Workbook();
  const data = wb.activeSheetId;
  [['Item', 'Price'], ['tea', '3'], ['cake', '5']].forEach((row, r) => row.forEach((v, c) => wb.setInput(data, r, c, v)));
  wb.addTable(data, { r1: 0, c1: 0, r2: 2, c2: 1 }, { header: true, name: 'Prices' });
  const report = wb.addSheet('Report').id;
  wb.setInput(report, 0, 0, 'cake');
  wb.setInput(report, 0, 1, '=VLOOKUP(A1,Prices,2,FALSE)');
  wb.setInput(report, 1, 1, '=ROWS(prices)');
  wb.setInput(report, 2, 1, '=SUM(Prices[Price])');
  return { wb, data, report };
}

it('traces the cells a bare table name reads', () => {
  const { wb, data, report } = book();
  expect(wb.getValue(report, 0, 1)).toBe(5);
  const cells = wb.precedents(report, 0, 1).map(({ sheetId, r, c }) => `${sheetId === data ? 'Data' : 'Report'}!${r},${c}`);
  expect(cells).toEqual(['Report!0,0', 'Data!1,0', 'Data!1,1', 'Data!2,0', 'Data!2,1']);
});

it('traces the formulas that read a table by its bare name', () => {
  const { wb, data, report } = book();
  const dependents = wb.dependents(data, 2, 1).map(({ r, c }) => wb.getCell(report, r, c).f);
  expect(dependents).toEqual(['VLOOKUP(A1,Prices,2,FALSE)', 'ROWS(prices)', 'SUM(Prices[Price])']);
  // The header row is no part of the table's data, which is what the bare name reads.
  expect(wb.dependents(data, 0, 1).map(({ r, c }) => wb.getCell(report, r, c).f)).toEqual([]);
});

it('leaves functions, unknown names and defined names as they were', () => {
  const { wb, report } = book();
  wb.defineName('Pick', '=Report!$A$1');
  wb.setInput(report, 3, 1, '=PI()*Pick+Nowhere');
  expect(wb.precedents(report, 3, 1).map(({ r, c }) => `${r},${c}`)).toEqual(['0,0']);
});
