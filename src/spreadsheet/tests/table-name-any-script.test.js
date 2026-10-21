import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { validateTableName } from '../src/core/tables.js';

// A table name had to be spelt in ASCII letters, though Excel's names take letters of any script (its Japanese edition
// names tables テーブル1) and this app's defined names already did: naming or renaming a table Données or 売上 was
// refused. And R or C on its own, which Excel refuses as the shorthand for the current row or column, was accepted.
it('names a table in letters of any script, its formulas following a rename', () => {
  const wb = new Workbook({ sheets: [{ name: 'S' }] });
  const id = wb.activeSheetId;
  [['Prix', 'Qté'], ['1', '2'], ['5', '3']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const t = wb.addTable(id, { r1: 0, c1: 0, r2: 2, c2: 1 }, { name: 'Données' });
  expect(wb.tableById(id, t).name).toBe('Données');
  wb.setInput(id, 5, 0, '=SUM(Données[Prix])');
  expect(wb.getValue(id, 5, 0)).toBe(6);
  expect(wb.updateTable(id, t, { name: '売上' })).toBe(true);
  expect(wb.getCell(id, 5, 0).f).toBe('SUM(売上[Prix])');
  expect(wb.getValue(id, 5, 0)).toBe(6);
  expect(wb.rangeFromText(id, '売上')).toEqual({ sheetId: id, range: { r1: 0, c1: 0, r2: 2, c2: 1 } });
});

it('refuses R and C, and still refuses what is no name', () => {
  expect(validateTableName('R')).toBe('That looks like a cell reference');
  expect(validateTableName('c')).toBe('That looks like a cell reference');
  expect(validateTableName('R1C1')).toBe('That looks like a cell reference');
  expect(validateTableName('AB12')).toBe('That looks like a cell reference');
  for (const bad of ['1Sales', 'Sales Q1', 'a-b', 'x!y', '.x']) expect(validateTableName(bad)).not.toBe(null);
  for (const good of ['Sales_2024', 'テーブル1', 'Ümsatz.Q1', '_t', 'Rx', 'Cost']) expect(validateTableName(good)).toBe(null);
});
