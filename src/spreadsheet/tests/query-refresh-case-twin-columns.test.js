import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { evaluateQuery, loadResult, refreshQuery, saveQuery, queryByName } from '../src/core/queries.js';

// A query whose columns differ only by case ("Name" and "name", two names in M) loads into a table as Name and
// name2, a table's names differing without regard to case. On Refresh, name2 was taken for a column added by hand:
// it kept its old values for good and a third column, "name", took the fresh ones.
it('refreshes both columns of a query whose names differ only by case', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const id = wb.activeSheetId;
  saveQuery(wb, { name: 'Sales', source: { kind: 'csv', name: 's.csv', text: 'Name,name\nA,x\nB,y\n' }, steps: [{ type: 'promoteHeaders' }] });
  const q = queryByName(wb, 'Sales');
  loadResult(wb, q, (await evaluateQuery(wb, q, {})).table, { at: { sheetId: id, r: 0, c: 0 } });
  const grid = () => [0, 1, 2].map((r) => [0, 1, 2].map((c) => wb.getValue(id, r, c)));
  expect(grid()).toEqual([['Name', 'name2', null], ['A', 'x', null], ['B', 'y', null]]);
  const live = queryByName(wb, 'Sales');
  saveQuery(wb, { ...live, source: { ...live.source, text: 'Name,name\nA,p\nB,q\n' } });
  expect((await refreshQuery(wb, queryByName(wb, 'Sales'), {})).error).toBeUndefined();
  expect(grid()).toEqual([['Name', 'name2', null], ['A', 'p', null], ['B', 'q', null]]);
  expect(wb.tableColumns(id, wb.sheet(id).tables[0])).toEqual(['Name', 'name2']);
});
