import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';

// Deleting a table column (or the whole table) left the formulas that named it spelling out the dead column:
// SUM(T[Qty]) showed #REF! only until a column of that name came back, so renaming the Price column to Qty
// silently handed it every formula that had summed the deleted quantities. The references now read #REF!, as
// Excel writes them, everywhere they can be held, and undo puts them back.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, [['Item', 'Qty', 'Price'], ['a', 1, 10], ['b', 2, 20], ['c', 3, 30]]
    .flatMap((row, r) => row.map((v, c) => ({ r, c, cell: { v } }))));
  wb.addTable(id, parseRange('A1:C4'), { name: 'T' });
  wb.setInput(id, 1, 4, '=T[@Qty]*2'); // beside the table, on its row
  wb.addRule(id, { type: 'formula', range: parseRange('A2:A4'), value: 'T[@Qty]>1', style: { bold: true } });
  wb.addValidation(id, { type: 'list', range: parseRange('G1:G1'), source: '=T[Qty]' });
  wb.defineName('Units', '=T[Qty]');
  const x = wb.addSheet('Summary').id;
  wb.setInput(x, 0, 0, '=SUM(T[Qty])');
  wb.setInput(x, 1, 0, '=SUM(T[[Qty]:[Price]])');
  wb.setInput(x, 2, 0, '=SUM(T[Price])');
  wb.setInput(x, 3, 0, '=SUM(Units)');
  wb.setInput(x, 4, 0, '=ROWS(T)');
  wb.clearHistory();
  const formulas = () => [0, 1, 2, 3, 4].map((r) => wb.getCell(x, r, 0).f);
  return { wb, id, x, formulas };
}

it('turns references to a deleted table column into #REF!, so a column later given its name takes none of them', () => {
  const { wb, id, x, formulas } = book();
  const before = wb.toJSON();
  wb.deleteCols(id, 1, 1);
  expect(formulas()).toEqual(['SUM(#REF!)', 'SUM(#REF!)', 'SUM(T[Price])', 'SUM(Units)', 'ROWS(T)']);
  expect(wb.getCell(id, 1, 3).f).toBe('#REF!*2');
  expect(wb.sheet(id).rules[0].value).toBe('#REF!>1');
  expect(wb.sheet(id).validations[0].source).toBe('=#REF!');
  expect(wb.names.find((n) => n.name === 'Units').ref).toBe('#REF!');
  // Renaming Price to Qty renames the references to Price, and only those.
  wb.setInput(id, 0, 1, 'Qty');
  expect(formulas()).toEqual(['SUM(#REF!)', 'SUM(#REF!)', 'SUM(T[Qty])', 'SUM(Units)', 'ROWS(T)']);
  expect(wb.getValue(x, 0, 0)).toEqual({ error: '#REF!' });
  expect(wb.getValue(x, 3, 0)).toEqual({ error: '#REF!' });
  expect(wb.getValue(x, 2, 0)).toBe(60);
  wb.undo(); wb.undo();
  expect(wb.toJSON()).toEqual(before);
  expect(wb.getValue(x, 0, 0)).toBe(6);
});

it('does the same when the column goes with Delete cells, or the whole table with its rows', () => {
  let { wb, id, formulas } = book();
  expect(wb.deleteCells(id, parseRange('B1:B4'), 'left')).toBe(true);
  expect(formulas()).toEqual(['SUM(#REF!)', 'SUM(#REF!)', 'SUM(T[Price])', 'SUM(Units)', 'ROWS(T)']);
  ({ wb, id, formulas } = book());
  wb.deleteRows(id, 0, 4);
  expect(wb.sheet(id).tables).toEqual([]);
  expect(formulas()).toEqual(['SUM(#REF!)', 'SUM(#REF!)', 'SUM(#REF!)', 'SUM(Units)', 'ROWS(#REF!)']);
  expect(wb.getValue(wb.sheets[1].id, 4, 0)).toEqual({ error: '#REF!' });
});

it('leaves references to the columns that remain, and a range whose ends both remain', () => {
  const { wb, id, x, formulas } = book();
  wb.setInput(x, 5, 0, '=SUM(T[[Item]:[Price]])');
  wb.deleteCols(id, 1, 1); // Qty, between Item and Price
  expect(formulas()[2]).toBe('SUM(T[Price])');
  expect(wb.getCell(x, 5, 0).f).toBe('SUM(T[[Item]:[Price]])');
  expect(wb.getValue(x, 5, 0)).toBe(60);
});
