import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

function setup(formula = '=[@Qty]*[@Price]') {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, [['Qty', 'Price', 'Amount'], [2, 4, null], [3, 5, null]].flatMap((row, r) => row.map((v, c) => ({ r: r + 2, c: c + 2, cell: { v } }))));
  const tid = wb.addTable(id, { r1: 2, c1: 2, r2: 4, c2: 4 }, { name: 'Sales' });
  wb.setInput(id, 3, 4, formula);
  const summary = wb.addSheet('Summary').id;
  wb.setInput(summary, 0, 0, '=SUM(Sales[Amount])');
  expect(wb.getValue(summary, 0, 0)).toBe(23);
  wb.clearHistory();
  return { wb, id, tid, summary };
}

it.each([
  ['insert', 'down', { r1: 1, c1: 2, r2: 1, c2: 4 }, { r1: 3, c1: 2, r2: 5, c2: 4 }],
  ['delete', 'up', { r1: 1, c1: 2, r2: 1, c2: 4 }, { r1: 1, c1: 2, r2: 3, c2: 4 }],
  ['insert', 'right', { r1: 2, c1: 1, r2: 4, c2: 1 }, { r1: 2, c1: 3, r2: 4, c2: 5 }],
  ['delete', 'left', { r1: 2, c1: 1, r2: 4, c2: 1 }, { r1: 2, c1: 1, r2: 4, c2: 3 }],
  ['insert', 'down', { r1: 4, c1: 2, r2: 4, c2: 4 }, { r1: 2, c1: 2, r2: 5, c2: 4 }],
  ['insert', 'right', { r1: 2, c1: 3, r2: 4, c2: 3 }, { r1: 2, c1: 2, r2: 4, c2: 5 }],
])('%s cells shifting %s preserves table references, templates, and undo (%j)', (mode, direction, range, expected) => {
  const { wb, id, tid, summary } = setup();
  const before = wb.toJSON();
  expect(wb[`${mode}Cells`](id, range, direction)).toBe(true);
  expect(wb.tableById(id, tid).range).toEqual(expected);
  expect(wb.getValue(summary, 0, 0)).toBe(23);
  const after = wb.toJSON();
  wb.undo();
  expect(wb.toJSON()).toEqual(before);
  wb.redo();
  expect(wb.toJSON()).toEqual(after);
  const row = wb.addTableRow(id, tid);
  const columns = wb.tableColumns(id, wb.tableById(id, tid));
  wb.setInput(id, row, expected.c1 + columns.indexOf('Qty'), '4');
  wb.setInput(id, row, expected.c1 + columns.indexOf('Price'), '6');
  expect(wb.getValue(id, row, expected.c1 + columns.indexOf('Amount'))).toBe(24);
  expect(wb.getValue(summary, 0, 0)).toBe(47);
});

it('rebases an A1 calculated-column template when its origin row is deleted', () => {
  const { wb, id, tid, summary } = setup('=C4*D4');
  wb.deleteCells(id, { r1: 3, c1: 2, r2: 3, c2: 4 }, 'up');
  expect(wb.tableById(id, tid).range.r2).toBe(3);
  expect(wb.getValue(summary, 0, 0)).toBe(15);
  const row = wb.addTableRow(id, tid);
  wb.setInput(id, row, 2, '4');
  wb.setInput(id, row, 3, '6');
  expect(wb.getCell(id, row, 4).f).toBe(`C${row + 1}*D${row + 1}`);
  expect(wb.getValue(id, row, 4)).toBe(24);
});

it.each([
  ['insert', 'down', { r1: 1, c1: 2, r2: 1, c2: 2 }],
  ['delete', 'up', { r1: 1, c1: 2, r2: 1, c2: 2 }],
  ['insert', 'right', { r1: 2, c1: 1, r2: 2, c2: 1 }],
  ['delete', 'left', { r1: 2, c1: 1, r2: 2, c2: 1 }],
  ['delete', 'up', { r1: 2, c1: 2, r2: 2, c2: 4 }],
])('refuses %s shifting %s that would split a table or delete only its header', (mode, direction, range) => {
  const { wb, id } = setup();
  const before = wb.toJSON();
  expect(wb[`${mode}Cells`](id, range, direction)).toBe(false);
  expect(wb.toJSON()).toEqual(before);
  expect(wb.canUndo()).toBe(false);
});

it('removes a table when every cell is deleted and restores it on undo', () => {
  const { wb, id, tid, summary } = setup();
  const before = wb.toJSON();
  expect(wb.deleteCells(id, { r1: 2, c1: 2, r2: 4, c2: 4 }, 'up')).toBe(true);
  expect(wb.tableById(id, tid)).toBeNull();
  expect(wb.sheet(id).filter).toBeNull();
  // The reference to the deleted table reads #REF!, as Excel writes it, and undo brings it back.
  expect(wb.getCell(summary, 0, 0).f).toBe('SUM(#REF!)');
  expect(wb.getValue(summary, 0, 0)).toEqual({ error: '#REF!' });
  wb.undo();
  expect(wb.toJSON()).toEqual(before);
  expect(wb.getValue(summary, 0, 0)).toBe(23);
});

it('turns totals off when their cells are deleted without absorbing the last data row', () => {
  const { wb, id, tid, summary } = setup();
  wb.setTableTotals(id, tid, true);
  expect(wb.deleteCells(id, { r1: 5, c1: 2, r2: 5, c2: 4 }, 'up')).toBe(true);
  expect(wb.tableById(id, tid)).toMatchObject({ totalsRow: false, range: { r1: 2, c1: 2, r2: 4, c2: 4 } });
  expect(wb.getValue(summary, 0, 0)).toBe(23);
  wb.undo();
  expect(wb.tableById(id, tid).totalsRow).toBe(true);
  expect(wb.getValue(id, 5, 4)).toBe(23);
});

it('updates calculated-column templates on other sheets that reference shifted cells', () => {
  const { wb, id, summary } = setup();
  wb.setInput(summary, 2, 1, 'Other');
  const other = wb.addTable(summary, { r1: 2, c1: 1, r2: 3, c2: 1 });
  wb.setInput(summary, 3, 1, '=Sheet1!$E$4');
  wb.insertCells(id, { r1: 1, c1: 2, r2: 1, c2: 4 }, 'down');
  expect(wb.getValue(summary, 3, 1)).toBe(8);
  expect(wb.tableById(summary, other).calc['0']).toBe('Sheet1!$E$5');
  const row = wb.addTableRow(summary, other);
  expect(wb.getValue(summary, row, 1)).toBe(8);
});
