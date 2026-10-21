import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { evaluateQuery, loadResult, refreshQuery, saveQuery, queryByName } from '../src/core/queries.js';

// A query remembers the columns it loaded last, to tell them from columns added to its table by hand. Undoing a
// refresh brought the table's old columns back but left that record as the refresh had set it, so a column the
// query had dropped was then taken for one added by hand: the next refresh kept it, with its stale values, for good.
it('takes a dropped column out again when a refresh that dropped it is undone and run again', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const id = wb.activeSheetId;
  saveQuery(wb, { name: 'Sales', source: { kind: 'csv', name: 's.csv', text: 'A,B,C\n1,2,3\n4,5,6\n' }, steps: [{ type: 'promoteHeaders' }] });
  const q = queryByName(wb, 'Sales');
  loadResult(wb, q, (await evaluateQuery(wb, q, {})).table, { at: { sheetId: id, r: 0, c: 0 } });
  const columns = () => wb.tableColumns(id, wb.sheet(id).tables[0]);
  expect(columns()).toEqual(['A', 'B', 'C']);
  const live = queryByName(wb, 'Sales');
  saveQuery(wb, { ...live, source: { ...live.source, text: 'A,B\n1,2\n4,5\n' } });
  expect((await refreshQuery(wb, queryByName(wb, 'Sales'), {})).error).toBeUndefined();
  expect(columns()).toEqual(['A', 'B']);
  expect(queryByName(wb, 'Sales').load.columns).toEqual(['A', 'B']);
  wb.undo();
  expect(columns()).toEqual(['A', 'B', 'C']);
  expect(queryByName(wb, 'Sales').load.columns).toEqual(['A', 'B', 'C']);
  expect(queryByName(wb, 'Sales').rowCount).toBe(2);
  wb.redo();
  expect(queryByName(wb, 'Sales').load.columns).toEqual(['A', 'B']);
  wb.undo();
  expect((await refreshQuery(wb, queryByName(wb, 'Sales'), {})).error).toBeUndefined();
  expect(columns()).toEqual(['A', 'B']);
  expect(wb.getValue(id, 1, 2)).toBe(null);
});
