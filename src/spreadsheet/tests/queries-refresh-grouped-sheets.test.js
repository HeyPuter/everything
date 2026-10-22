import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { evaluateQuery, loadResult, refreshQuery, refreshAll, saveQuery, queryByName } from '../src/core/queries.js';

// A query's table is written again by Refresh (Table Design) and Data > Refresh All. With its sheet grouped with
// another (both tabs selected), the cells the refresh rewrote were written over the same cells of the other sheet as
// well, as typing into a group is: the fresh records landed in the other sheet's data, in the same undo step.
async function book() {
  const wb = new Workbook({ sheets: [{ name: 'Data' }, { name: 'Notes' }] });
  const [data, notes] = wb.sheets.map((s) => s.id);
  saveQuery(wb, { name: 'Sales', source: { kind: 'csv', name: 's.csv', text: 'Region,Amount\nEast,2\nWest,4\n' },
    steps: [{ type: 'promoteHeaders' }, { type: 'changeType', columns: { Amount: 'decimal' } }] });
  const q = queryByName(wb, 'Sales');
  wb.setActiveSheet(data);
  loadResult(wb, q, (await evaluateQuery(wb, q, {})).table, { at: { sheetId: data, r: 0, c: 0 } });
  wb.setInput(notes, 0, 0, 'Mine'); wb.setInput(notes, 2, 1, '42');
  const live = queryByName(wb, 'Sales');
  saveQuery(wb, { ...live, source: { ...live.source, text: 'Region,Amount\nNorth,9\nEast,2\nWest,4\n' } });
  wb.groupSheets([data, notes]);
  return { wb, data, notes };
}
const grid = (wb, id) => Array.from({ length: 5 }, (_, r) => [0, 1].map((c) => wb.getValue(id, r, c)));

it('rewrites a query\'s table on its own sheet only, whatever sheets are grouped with it', async () => {
  for (const refresh of [(wb) => refreshQuery(wb, queryByName(wb, 'Sales'), {}), (wb) => refreshAll(wb, {})]) {
    const { wb, data, notes } = await book();
    const before = grid(wb, notes);
    expect(wb.sheetGroup).toHaveLength(2);
    await refresh(wb);
    expect(grid(wb, data).slice(0, 4)).toEqual([['Region', 'Amount'], ['North', 9], ['East', 2], ['West', 4]]);
    expect(grid(wb, notes)).toEqual(before);
  }
});

it('takes a query\'s table off its own sheet only when it becomes a connection', async () => {
  const { wb, data, notes } = await book();
  const { unloadQuery } = await import('../src/core/queries.js');
  wb.setInput(notes, 1, 0, 'Kept');
  const before = grid(wb, notes);
  unloadQuery(wb, queryByName(wb, 'Sales'));
  expect(grid(wb, data)[1]).toEqual([null, null]);
  expect(grid(wb, notes)).toEqual(before);
});
