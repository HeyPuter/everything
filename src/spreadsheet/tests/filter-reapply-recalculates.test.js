import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';

// Data > Reapply hid and showed rows without telling the book they had changed: SUBTOTAL and AGGREGATE, which
// leave out the rows a filter hides, kept the totals of the rows shown before, the book was not marked as
// changed (the rows shown are saved with it), and in a shared workbook the others went on seeing the old rows.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Name', 'Region', 'Amount'], ['a', 'East', 1], ['b', 'West', 2], ['c', 'East', 3], ['d', 'West', 4]]
    .forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  wb.setInput(id, 6, 2, '=SUBTOTAL(109,C2:C5)');
  wb.setInput(id, 7, 2, '=AGGREGATE(9,5,C2:C5)');
  wb.setFilterRange(id, { r1: 0, c1: 0, r2: 4, c2: 2 });
  wb.setFilterCriteria(id, 1, { values: ['East'] });
  return { wb, id };
}

it('totals only the rows a reapplied filter shows', () => {
  const { wb, id } = book();
  expect(wb.getValue(id, 6, 2)).toBe(4);
  wb.setInput(id, 1, 1, 'West'); // the row stays in view until the filter is reapplied, as in Excel
  expect(wb.isRowHidden(id, 1)).toBe(false);
  expect(wb.getValue(id, 6, 2)).toBe(4);
  wb.markClean();
  wb.reapplyFilter(id);
  expect(wb.isRowHidden(id, 1)).toBe(true);
  expect(wb.getValue(id, 6, 2)).toBe(3);
  expect(wb.getValue(id, 7, 2)).toBe(3);
  expect(wb.dirty).toBe(true);
  expect(wb.toJSON().sheets[0].filterHidden).toEqual([1, 2, 4]);
});

it('leaves the book unchanged when reapplying shows the same rows', () => {
  const { wb, id } = book();
  wb.markClean();
  wb.reapplyFilter(id);
  expect(wb.dirty).toBe(false);
});

it('shows the others the rows a reapplied filter shows', () => {
  const log = [];
  const initial = book().wb.toJSON();
  const join = () => { const wb = new Workbook(JSON.parse(JSON.stringify(initial))); const rep = new Replica(wb); rep.receive([]); return { wb, rep }; };
  const sync = async ({ rep }) => {
    await Promise.resolve(); // a change made outside an undo step is gathered once the current task is done
    const out = rep.outgoing();
    if (out.length) log.push({ rev: log.length + 1, user: 'u', username: 'u', changes: JSON.parse(JSON.stringify(out)) });
    rep.receive(log.slice(rep.rev));
  };
  return (async () => {
    const alice = join(), bob = join();
    const id = alice.wb.activeSheetId;
    alice.wb.setInput(id, 1, 1, 'West');
    alice.wb.reapplyFilter(id);
    await sync(alice); await sync(bob);
    expect(bob.wb.isRowHidden(bob.wb.activeSheetId, 1)).toBe(true);
    expect(bob.wb.getValue(bob.wb.activeSheetId, 6, 2)).toBe(3);
  })();
});
