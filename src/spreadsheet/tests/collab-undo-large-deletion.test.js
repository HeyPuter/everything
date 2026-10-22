import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';
import { MAX_CHANGE } from '../src/collab/ops.js';

// Undoing a deletion of rows in a shared workbook puts the rows back and writes back what was on them, as one change.
// Undoing the deletion of 50,000 rows of names and amounts made a change larger than the room takes (4.3 million
// characters, the room taking 4 million): the room refused it for good, so the undo was taken back, with every edit
// made after it that had not reached the room yet. The rows now go back first and their cells follow in parts.
it('sends the undo of a long deletion in parts the room takes, and the others get every row back', async () => {
  const cells = {};
  for (let r = 0; r < 60000; r++) { cells[`${r},0`] = { v: `Customer name number ${r}` }; cells[`${r},1`] = { v: r * 3.5 }; }
  const json = new Workbook({ sheets: [{ name: 'Data', rows: 60000, cells }] }).toJSON();
  const mine = new Workbook(JSON.parse(JSON.stringify(json))), theirs = new Workbook(JSON.parse(JSON.stringify(json)));
  const rep = new Replica(mine), other = new Replica(theirs);
  const s = mine.sheets[0].id;
  let rev = 0;
  const deliver = () => {
    const out = rep.outgoing();
    for (const change of out) expect(JSON.stringify(change).length).toBeLessThanOrEqual(MAX_CHANGE);
    const records = out.map((change) => ({ rev: ++rev, user: 'a', username: 'a', changes: [JSON.parse(JSON.stringify(change))] }));
    rep.receive(records);
    other.receive(records);
    return out.length;
  };
  mine.deleteRows(s, 10, 50000);
  await null;
  deliver();
  expect(theirs.sheet(s).cells.size).toBe(20000);
  mine.undo();
  await null;
  expect(deliver()).toBeGreaterThan(2);
  expect(theirs.sheet(s).cells.size).toBe(120000);
  expect(theirs.getValue(s, 30000, 0)).toBe('Customer name number 30000');
  expect(theirs.getValue(s, 59999, 1)).toBe(59999 * 3.5);
}, 60000);
