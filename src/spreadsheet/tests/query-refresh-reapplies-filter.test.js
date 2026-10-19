import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { evaluateQuery, loadResult, refreshQuery, saveQuery, queryByName } from '../src/core/queries.js';

// A query's table filtered to Region = East kept hiding the same row positions after a refresh, though they
// now held other records: West rows showed and an East row was hidden. Excel's refresh applies the table's
// filter again (Preserve column sort/filter/layout), and so does the app now, in the refresh's one undo step.
it('applies the loaded table\'s filter to the refreshed rows', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const id = wb.activeSheetId;
  saveQuery(wb, { name: 'S', source: { kind: 'csv', name: 's.csv', text: 'Region,U\nEast,1\nWest,2\n' }, steps: [{ type: 'promoteHeaders' }] });
  const q = queryByName(wb, 'S');
  loadResult(wb, q, (await evaluateQuery(wb, q, {})).table, { at: { sheetId: id, r: 0, c: 0 } });
  wb.setFilterCriteria(id, 0, { values: ['East'] }, wb.filtersForSheet(id)[0]);
  expect([...wb.sheet(id).filterHidden]).toEqual([2]);

  const live = queryByName(wb, 'S');
  saveQuery(wb, { ...live, source: { ...live.source, text: 'Region,U\nWest,5\nEast,6\nWest,7\nWest,8\nEast,9\n' } });
  expect((await refreshQuery(wb, queryByName(wb, 'S'), {})).error).toBeUndefined();
  const shown = (r) => !wb.sheet(id).filterHidden.has(r);
  expect([1, 2, 3, 4, 5].filter(shown).map((r) => wb.getValue(id, r, 0))).toEqual(['East', 'East']);

  wb.undo();
  expect(wb.getValue(id, 1, 0)).toBe('East');
  expect([...wb.sheet(id).filterHidden]).toEqual([2]);
});
