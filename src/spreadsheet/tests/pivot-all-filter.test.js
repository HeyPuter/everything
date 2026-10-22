import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { buildPivot, PIVOT_AGGS, PIVOT_ALL } from '../src/core/pivot.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

function source(table = false) {
  const wb = new Workbook({ sheets: [{ name: 'Sales Data' }] });
  const id = wb.activeSheetId;
  const rows = [
    ['Region', 'Quarter', 'Amount', 'Channel', 'Agent'],
    ['East', 'Q1', '10', '', ''],
    ['East', 'Q1', '20', 'Retail', 'Alex'],
    ['East', 'Q2', '30', '=""', 'Alex'],
    ['West', 'Q2', '40', 'Retail', ''],
    ['West', 'Q2', '-5', '=1/0', 'Alex'],
    ['East', 'Q1', '', '', 'Alex'],
  ];
  rows.forEach((row, r) => row.forEach((value, c) => wb.setInput(id, r, c, value)));
  const range = parseRange('A1:E7');
  if (table) wb.addTable(id, range, { name: 'Sales' });
  return { wb, id, range };
}

function place(wb, id, range, spec = {}) {
  const built = buildPivot(wb, id, { range, rowField: 0, colField: 1, valueField: 2, agg: 'sum', ...spec });
  const sheet = wb.addSheet('Pivot');
  wb.setCells(sheet.id, built.cells);
  const values = () => Array.from({ length: built.rowCount + 1 }, (_, r) =>
    Array.from({ length: built.cols - 1 }, (_, c) => wb.getValue(sheet.id, built.headerRow + 1 + r, c + 1)));
  return { sheet, values };
}

it.each(PIVOT_AGGS.map(([agg]) => agg))('keeps %s results unchanged when adding a filter set to All', (agg) => {
  const { wb, id, range } = source();
  const plain = place(wb, id, range, { agg });
  const filtered = place(wb, id, range, { agg, filters: [{ field: 3, value: null }] });
  expect(filtered.values()).toEqual(plain.values());
  wb.setInput(filtered.sheet.id, 0, 1, 'Retail');
  expect(filtered.values()).not.toEqual(plain.values());
  wb.setInput(filtered.sheet.id, 0, 1, PIVOT_ALL);
  expect(filtered.values()).toEqual(plain.values());
});

it('lets each All report filter pass rows with empty fields independently', () => {
  const { wb, id, range } = source();
  const { sheet, values } = place(wb, id, range, { filters: [{ field: 3, value: null }, { field: 4, value: null }] });
  expect(values().at(-1)).toEqual([30, 65, 95]);
  wb.setInput(sheet.id, 1, 1, 'Alex');
  expect(values().at(-1)).toEqual([20, 25, 45]);
  wb.setInput(sheet.id, 0, 1, 'Retail');
  expect(values().at(-1)).toEqual([20, '', 20]);
  wb.setInput(sheet.id, 1, 1, PIVOT_ALL);
  expect(values().at(-1)).toEqual([20, 40, 60]);
});

it('keeps All filters live after table growth and xlsx round trips', async () => {
  const { wb, id, range } = source(true);
  const { sheet, values } = place(wb, id, range, { filters: [{ field: 3, value: null }] });
  expect(values().at(-1)).toEqual([30, 65, 95]);
  ['East', 'Q1', '50', '', 'Alex'].forEach((value, c) => wb.setInput(id, 7, c, value));
  expect(values().at(-1)).toEqual([80, 65, 145]);
  const back = await workbookFromFile(await workbookToXlsx(wb), 'pivot.xlsx');
  const pivot = back.sheetByName(sheet.name);
  expect(back.getValue(pivot.id, 5, 3)).toBe(145);
  back.setInput(pivot.id, 0, 1, 'Retail');
  expect(back.getValue(pivot.id, 5, 3)).toBe(60);
  back.setInput(pivot.id, 0, 1, PIVOT_ALL);
  expect(back.getValue(pivot.id, 5, 3)).toBe(145);
});

it('separates real All labels from the all-values filter, including after saving', async () => {
  const { wb, id, range } = source();
  const categories = ['(All)', '(ALL VALUES)', '(All values 2)', 'Retail', '(all)'];
  categories.forEach((value, i) => wb.setInput(id, i + 1, 3, value));
  const built = buildPivot(wb, id, { range, rowField: 0, valueField: 2, agg: 'sum', filters: [{ field: 3, value: '(All)' }] });
  const sheet = wb.addSheet('Pivot');
  wb.setCells(sheet.id, built.cells);
  const all = built.filterCells[0].values[0];
  const totalRow = built.rows - 1;
  expect(wb.getValue(sheet.id, totalRow, 1)).toBe(5);
  expect(categories.map((v) => v.toLowerCase())).not.toContain(all.toLowerCase());
  wb.setInput(sheet.id, 0, 1, all);
  expect(wb.getValue(sheet.id, totalRow, 1)).toBe(95);
  const back = await workbookFromFile(await workbookToXlsx(wb), 'pivot.xlsx');
  const pivot = back.sheetByName('Pivot');
  back.setInput(pivot.id, 0, 1, '(All)');
  expect(back.getValue(pivot.id, totalRow, 1)).toBe(5);
  back.setInput(pivot.id, 0, 1, all);
  expect(back.getValue(pivot.id, totalRow, 1)).toBe(95);
});
