import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { evaluateQuery, loadResult, refreshQuery, saveQuery, queryByName, unloadQuery, loadedTable } from '../src/core/queries.js';

// Load To ▸ Only Create Connection takes a query's table away. Undoing it brought the table back, but the query went on
// as a connection only: a refresh then counted the rows and left the table with its old data for good.
it('loads to its table again once Only Create Connection is undone', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const id = wb.activeSheetId;
  saveQuery(wb, { name: 'Sales', source: { kind: 'csv', name: 's.csv', text: 'A,B\n1,2\n' }, steps: [{ type: 'promoteHeaders' }] });
  const q = queryByName(wb, 'Sales');
  loadResult(wb, q, (await evaluateQuery(wb, q, {})).table, { at: { sheetId: id, r: 0, c: 0 } });
  unloadQuery(wb, queryByName(wb, 'Sales'));
  expect(queryByName(wb, 'Sales').load).toEqual({ kind: 'connection' });
  expect(wb.sheet(id).tables).toHaveLength(0);
  wb.undo();
  expect(loadedTable(wb, queryByName(wb, 'Sales'))?.table.name).toBe('Sales');
  wb.redo();
  expect(queryByName(wb, 'Sales').load).toEqual({ kind: 'connection' });
  wb.undo();
  const live = queryByName(wb, 'Sales');
  saveQuery(wb, { ...live, source: { ...live.source, text: 'A,B\n9,8\n' } });
  expect((await refreshQuery(wb, queryByName(wb, 'Sales'), {})).error).toBeUndefined();
  expect([wb.getValue(id, 1, 0), wb.getValue(id, 1, 1)]).toEqual(['9', '8']);
});
