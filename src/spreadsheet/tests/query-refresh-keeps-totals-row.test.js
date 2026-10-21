import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { evaluateQuery, loadResult, refreshQuery, saveQuery, queryByName } from '../src/core/queries.js';

// A query's table given a Total Row lost it on refresh: the table was resized to the header and the data alone,
// so the last record became the totals row (left out of SUM(Sales[Qty]) and drawn as the totals) and the totals'
// formulas were cleared. Excel's refresh keeps the totals row under the fresh data; so does the app now.
async function loaded(text) {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const id = wb.activeSheetId;
  saveQuery(wb, { name: 'Sales', source: { kind: 'csv', name: 's.csv', text }, steps: [{ type: 'promoteHeaders' }, { type: 'changeType', columns: { Qty: 'int' } }] });
  const q = queryByName(wb, 'Sales');
  loadResult(wb, q, (await evaluateQuery(wb, q, {})).table, { at: { sheetId: id, r: 0, c: 0 } });
  wb.setTableTotals(id, wb.sheet(id).tables[0].id, true);
  return { wb, id };
}

async function refresh(wb, text) {
  const live = queryByName(wb, 'Sales');
  saveQuery(wb, { ...live, source: { ...live.source, text } });
  expect((await refreshQuery(wb, queryByName(wb, 'Sales'), {})).error).toBeUndefined();
}

const column = (wb, id, c, rows) => Array.from({ length: rows }, (_, r) => wb.getValue(id, r, c) ?? null);

it('keeps the totals row under more rows after a refresh', async () => {
  const { wb, id } = await loaded('Name,Qty\na,1\nb,2\nc,3\n');
  expect(wb.sheet(id).tables[0].range).toMatchObject({ r1: 0, r2: 4 });
  await refresh(wb, 'Name,Qty\na,1\nb,2\nc,3\nd,4\ne,5\n');
  const t = wb.sheet(id).tables[0];
  expect(t.totalsRow).toBe(true);
  expect(t.range).toMatchObject({ r1: 0, r2: 6 });
  expect(column(wb, id, 0, 8)).toEqual(['Name', 'a', 'b', 'c', 'd', 'e', 'Total', null]);
  expect(wb.getCell(id, 6, 1).f).toBe('SUBTOTAL(109,Sales[Qty])');
  expect(wb.getValue(id, 6, 1)).toBe(15);

  wb.undo();
  expect(column(wb, id, 0, 6)).toEqual(['Name', 'a', 'b', 'c', 'Total', null]);
  expect(wb.getValue(id, 4, 1)).toBe(6);
});

it('keeps the totals row over fewer rows and columns after a refresh', async () => {
  const { wb, id } = await loaded('Name,Qty,Note\na,1,x\nb,2,y\nc,3,z\nd,4,w\n');
  await refresh(wb, 'Name,Qty\na,1\nb,2\n');
  const t = wb.sheet(id).tables[0];
  expect(t.range).toEqual({ r1: 0, c1: 0, r2: 3, c2: 1 });
  expect(column(wb, id, 0, 6)).toEqual(['Name', 'a', 'b', 'Total', null, null]);
  expect(wb.getValue(id, 3, 1)).toBe(3);
  // Nothing of the old rows or of the column the query no longer gives is left behind.
  expect(column(wb, id, 1, 6)).toEqual(['Qty', 1, 2, 3, null, null]);
  expect(column(wb, id, 2, 6)).toEqual([null, null, null, null, null, null]);
});
