import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { evaluateQuery, loadResult, refreshQuery, saveQuery, queryByName } from '../src/core/queries.js';

/** A query over CSV text loaded as a table at A1, with a calculated Total typed beside it as a person would. */
async function loaded(text = 'a,b\n1,2\n3,4\n') {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const id = wb.activeSheetId;
  saveQuery(wb, { name: 'Sales', source: { kind: 'csv', name: 's.csv', text }, steps: [{ type: 'promoteHeaders' }] });
  const q = queryByName(wb, 'Sales');
  expect(loadResult(wb, q, (await evaluateQuery(wb, q, {})).table, { at: { sheetId: id, r: 0, c: 0 } }).error).toBeUndefined();
  wb.setInput(id, 0, 2, 'Total');
  wb.setInput(id, 1, 2, '=[@a]*10');
  return { wb, id };
}
async function refresh(wb, text, steps = null) {
  const live = queryByName(wb, 'Sales');
  saveQuery(wb, { ...live, source: { ...live.source, text }, ...(steps ? { steps } : {}) });
  const res = await refreshQuery(wb, queryByName(wb, 'Sales'), {});
  expect(res.error).toBeUndefined();
  return res;
}
const table = (wb, id) => wb.sheet(id).tables[0];
const grid = (wb, id, rows, cols) => Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => wb.getValue(id, r, c)));

it('keeps a calculated column added to a loaded table through a refresh, filling the new rows', async () => {
  const { wb, id } = await loaded();
  expect(grid(wb, id, 3, 3)).toEqual([['a', 'b', 'Total'], ['1', '2', 10], ['3', '4', 30]]);
  await refresh(wb, 'a,b\n1,2\n3,4\n5,6\n');
  expect(table(wb, id).range).toMatchObject({ r1: 0, c1: 0, r2: 3, c2: 2 });
  expect(grid(wb, id, 4, 3)).toEqual([['a', 'b', 'Total'], ['1', '2', 10], ['3', '4', 30], ['5', '6', 50]]);
  // One undo puts the table back as it was before the refresh.
  wb.undo();
  expect(table(wb, id).range).toMatchObject({ r2: 2, c2: 2 });
  expect(grid(wb, id, 3, 3)).toEqual([['a', 'b', 'Total'], ['1', '2', 10], ['3', '4', 30]]);
});

it('lays a column the query gains after the table\'s own, takes out one it drops, and trims rows it loses', async () => {
  const { wb, id } = await loaded('a,b\n1,2\n3,4\n5,6\n');
  await refresh(wb, 'a,b,c\n1,2,x\n3,4,y\n5,6,z\n');
  expect(grid(wb, id, 4, 4)).toEqual([['a', 'b', 'Total', 'c'], ['1', '2', 10, 'x'], ['3', '4', 30, 'y'], ['5', '6', 50, 'z']]);
  await refresh(wb, 'a,c\n7,p\n');
  expect(table(wb, id).range).toMatchObject({ r1: 0, c1: 0, r2: 1, c2: 2 });
  expect(grid(wb, id, 4, 4)).toEqual([['a', 'Total', 'c', null], ['7', 70, 'p', null], [null, null, null, null], [null, null, null, null]]);
});

it('keeps notes typed into a column of the table\'s own, and remembers which columns are the query\'s across saving', async () => {
  const { wb, id } = await loaded();
  wb.setInput(id, 0, 3, 'Checked');
  wb.setInput(id, 1, 3, 'yes');
  expect(table(wb, id).range.c2).toBe(3);
  const reopened = await workbookFromFile(await workbookToXlsx(wb), 'q.xlsx');
  const rid = reopened.sheets[0].id;
  expect(queryByName(reopened, 'Sales').load.columns).toEqual(['a', 'b']);
  await refresh(reopened, 'a,b\n1,2\n3,4\n');
  expect(grid(reopened, rid, 3, 4)).toEqual([['a', 'b', 'Total', 'Checked'], ['1', '2', 10, 'yes'], ['3', '4', 30, null]]);
});

it('still rewrites a table with no columns of its own as the query lays it out', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const id = wb.activeSheetId;
  saveQuery(wb, { name: 'Sales', source: { kind: 'csv', name: 's.csv', text: 'a,b\n1,2\n' }, steps: [{ type: 'promoteHeaders' }] });
  const q = queryByName(wb, 'Sales');
  loadResult(wb, q, (await evaluateQuery(wb, q, {})).table, { at: { sheetId: id, r: 0, c: 0 } });
  await refresh(wb, 'b,a\n2,1\n4,3\n');
  expect(grid(wb, id, 3, 2)).toEqual([['b', 'a'], ['2', '1'], ['4', '3']]);
});
