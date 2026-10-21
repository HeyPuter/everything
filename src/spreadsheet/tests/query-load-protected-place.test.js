import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { evaluateQuery, loadResult, refreshQuery, saveQuery, queryByName } from '../src/core/queries.js';

// Loading a query to a place on the sheet that crossed a protected range wrote none of its data (the protection
// refused the cells) but still made a table there, headed Column1, Column2, and reported "2 rows loaded"; a refresh
// into such a place likewise resized the table around data it could not write. Both are refused now, nothing done.
async function setup(text = 'A,B\n1,2\n3,4\n') {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  saveQuery(wb, { name: 'S', source: { kind: 'csv', name: 's.csv', text }, steps: [{ type: 'promoteHeaders' }] });
  const run = async () => (await evaluateQuery(wb, queryByName(wb, 'S'), {})).table;
  return { wb, id, run };
}

it('refuses to load over a protected range and makes no table', async () => {
  const { wb, id, run } = await setup();
  wb.protectRange(id, { r1: 2, c1: 1, r2: 2, c2: 1 });
  const before = wb.historyTop;
  expect(loadResult(wb, queryByName(wb, 'S'), await run(), { at: { sheetId: id, r: 0, c: 0 } }).error).toMatch(/protected/);
  expect(wb.sheet(id).tables).toEqual([]);
  expect(queryByName(wb, 'S').load.kind).toBe('connection');
  expect(wb.historyTop).toBe(before);
});

it('refuses a refresh that would write over a protected range, leaving the table as it was', async () => {
  const { wb, id, run } = await setup();
  expect(loadResult(wb, queryByName(wb, 'S'), await run(), { at: { sheetId: id, r: 0, c: 0 } }).error).toBeUndefined();
  wb.protectRange(id, { r1: 4, c1: 0, r2: 4, c2: 0 });
  const live = queryByName(wb, 'S');
  saveQuery(wb, { ...live, source: { ...live.source, text: 'A,B\n1,2\n3,4\n5,6\n7,8\n' } });
  expect((await refreshQuery(wb, queryByName(wb, 'S'), {})).error).toMatch(/protected/);
  expect(wb.sheet(id).tables[0].range).toEqual({ r1: 0, c1: 0, r2: 2, c2: 1 });
  expect(wb.getValue(id, 2, 0)).toBe('3');
});
