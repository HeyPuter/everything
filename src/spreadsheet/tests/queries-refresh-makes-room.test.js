import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { evaluateQuery, loadResult, refreshQuery, saveQuery, queryByName } from '../src/core/queries.js';

/** A query over CSV text loaded as a table at A1 of the sheet; `grow` swaps in a longer or wider source. */
async function loaded(text) {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const id = wb.activeSheetId;
  saveQuery(wb, { name: 'Sales', source: { kind: 'csv', name: 's.csv', text }, steps: [{ type: 'promoteHeaders' }, { type: 'changeType', columns: { a: 'int' } }] });
  const q = queryByName(wb, 'Sales');
  const out = loadResult(wb, q, (await evaluateQuery(wb, q, {})).table, { at: { sheetId: id, r: 0, c: 0 } });
  expect(out.error).toBeUndefined();
  const refresh = async (next) => {
    const live = queryByName(wb, 'Sales');
    saveQuery(wb, { ...live, source: { ...live.source, text: next } });
    return refreshQuery(wb, queryByName(wb, 'Sales'), {});
  };
  return { wb, id, refresh };
}

it('moves what stands below a loaded table down when a refresh brings more rows, instead of writing over it', async () => {
  const { wb, id, refresh } = await loaded('a,b\n1,2\n3,4\n');
  wb.setInput(id, 4, 0, 'Checked by Ann');
  wb.setInput(id, 5, 0, 'Total');
  wb.setInput(id, 5, 1, '=SUM(Sales[a])');
  expect(wb.getValue(id, 5, 1)).toBe(4);

  const res = await refresh('a,b\n1,2\n3,4\n5,6\n7,8\n9,10\n');
  expect(res.error).toBeUndefined();
  expect(wb.sheet(id).tables[0].range).toMatchObject({ r1: 0, r2: 5, c1: 0, c2: 1 });
  expect([1, 2, 3, 4, 5].map((r) => wb.getValue(id, r, 0))).toEqual([1, 3, 5, 7, 9]);
  // The note and the total kept their place relative to the table: three rows further down.
  expect(wb.getValue(id, 7, 0)).toBe('Checked by Ann');
  expect(wb.getValue(id, 8, 0)).toBe('Total');
  expect(wb.getValue(id, 8, 1)).toBe(25);

  // One undo puts the old rows and the cells below back where they were.
  wb.undo();
  expect(wb.getValue(id, 4, 0)).toBe('Checked by Ann');
  expect(wb.getValue(id, 5, 1)).toBe(4);
});

it('moves cells beside a loaded table right when a refresh brings more columns', async () => {
  const { wb, id, refresh } = await loaded('a,b\n1,2\n3,4\n');
  wb.setInput(id, 0, 3, 'Notes');
  wb.setInput(id, 1, 3, 'keep me');
  const res = await refresh('a,b,c,d\n1,2,x,y\n3,4,z,w\n');
  expect(res.error).toBeUndefined();
  expect(wb.sheet(id).tables[0].range).toMatchObject({ r1: 0, r2: 2, c1: 0, c2: 3 });
  expect(wb.getValue(id, 1, 3)).toBe('y');
  expect(wb.getValue(id, 0, 5)).toBe('Notes');
  expect(wb.getValue(id, 1, 5)).toBe('keep me');
});

it('moves another table below a loaded table down rather than refusing the refresh and losing the rows', async () => {
  const { wb, id, refresh } = await loaded('a,b\n1,2\n');
  [['x', 'y'], ['1', '2']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, 3 + r, c, v)));
  wb.addTable(id, { r1: 3, c1: 0, r2: 4, c2: 1 }, { name: 'Below' });
  const res = await refresh('a,b\n1,2\n3,4\n5,6\n7,8\n');
  expect(res.error).toBeUndefined();
  expect([1, 2, 3, 4].map((r) => wb.getValue(id, r, 0))).toEqual([1, 3, 5, 7]);
  expect(wb.tableByName('Below').table.range).toMatchObject({ r1: 6, r2: 7 });
  expect(wb.getValue(id, 6, 0)).toBe('x');
});

it('leaves the cells far enough below alone, and needs no room when the new rows land on empty cells', async () => {
  const { wb, id, refresh } = await loaded('a,b\n1,2\n');
  wb.setInput(id, 20, 0, 'far below');
  await refresh('a,b\n1,2\n3,4\n5,6\n');
  expect(wb.getValue(id, 20, 0)).toBe('far below');
  expect([1, 2, 3].map((r) => wb.getValue(id, r, 0))).toEqual([1, 3, 5]);
});
