import { afterEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';

// Undoing a deletion of the rows a filter shows puts each run of rows back with an insertion of its own, and each went
// in on its own: every one renumbered the whole sheet (its cells, its formulas, a structural snapshot) and, here, read
// the whole sheet again into the shared copy, so the time grew with the square of the runs. Undoing a deletion of
// 10,000 runs took 19 s here and 13 s on everyone else's copy, its redo as long. Insertions one below another now go
// in at once, as deletions each above the one before do, and the sheet is renumbered once for all of them.
afterEach(() => vi.restoreAllMocks());

it('renumbers the sheet once, not once per run, to undo and redo a deletion of many runs of rows', async () => {
  const n = 4002;
  const cells = {};
  for (let r = 0; r < n; r++) { cells[`${r},0`] = { v: r }; if (r % 7 === 1) cells[`${r},1`] = { v: null, f: `A${r + 1}*2` }; }
  cells['0,2'] = { v: null, f: `SUM(A1:A${n})` };
  const json = new Workbook({ sheets: [{ name: 'S', rows: n, cells }] }).toJSON();
  const mine = new Workbook(JSON.parse(JSON.stringify(json))), theirs = new Workbook(JSON.parse(JSON.stringify(json)));
  const rep = new Replica(mine), other = new Replica(theirs);
  const s = mine.sheets[0].id;
  let rev = 0;
  const deliver = () => {
    const records = rep.outgoing().map((change) => ({ rev: ++rev, user: 'a', username: 'a', changes: [JSON.parse(JSON.stringify(change))] }));
    rep.receive(records);
    other.receive(records);
  };
  const evens = [];
  for (let r = 2; r < n; r += 2) evens.push({ from: r, to: r });
  mine.deleteLines(s, 'row', evens);
  await null;
  deliver();
  const inserts = vi.spyOn(Workbook.prototype, '_insertLines'), deletes = vi.spyOn(Workbook.prototype, '_deleteLines');
  const each = (wb) => [inserts, deletes].map((spy) => spy.mock.contexts.filter((c) => c === wb).length);
  mine.undo();
  await null;
  deliver();
  expect(each(mine)).toEqual([1, 0]);
  expect(each(theirs)).toEqual([1, 0]);
  for (const wb of [mine, theirs]) {
    expect(wb.sheet(s).cells.size).toBe(Object.keys(cells).length);
    expect([wb.getValue(s, 2, 0), wb.getValue(s, 3000, 0), wb.getCell(s, 3004, 1).f, wb.getValue(s, 0, 2)]).toEqual([2, 3000, 'A3005*2', (n - 1) * n / 2]);
  }
  inserts.mockClear(); deletes.mockClear();
  mine.redo();
  await null;
  deliver();
  expect(each(mine)).toEqual([0, 1]);
  expect(each(theirs)).toEqual([0, 1]);
  for (const wb of [mine, theirs]) expect([wb.sheet(s).rows, wb.getValue(s, 2, 0), wb.getValue(s, 3, 0)]).toEqual([n - evens.length, 3, 5]);
});
