import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';
import { MAX_CHANGE } from '../src/collab/ops.js';

// A sheet added to a shared workbook travels whole, and a copy of a long sheet (60,000 rows of names and amounts)
// made a change larger than the room takes in one. The room refused it for good, so the copy was taken back, with
// every edit made after it that had not reached the room yet. Such a sheet now travels as the sheet without its cells,
// then its cells in parts, as a long paste does.
it('sends a copy of a long sheet in parts the room takes, and the others get the whole copy', async () => {
  const cells = {};
  for (let r = 0; r < 60000; r++) { cells[`${r},0`] = { v: `Customer name number ${r}` }; cells[`${r},1`] = { v: r * 3.5, s: { bold: r % 2 === 0 } }; }
  const json = new Workbook({ sheets: [{ name: 'Data', cells }] }).toJSON();
  const mine = new Workbook(JSON.parse(JSON.stringify(json))), theirs = new Workbook(JSON.parse(JSON.stringify(json)));
  const rep = new Replica(mine), other = new Replica(theirs);
  const copy = mine.duplicateSheet(mine.sheets[0].id);
  mine.setInput(mine.sheets[0].id, 0, 5, 'typed after');
  await null;
  const out = rep.outgoing();
  expect(out.length).toBeGreaterThan(2);
  for (const change of out) expect(JSON.stringify(change).length).toBeLessThanOrEqual(MAX_CHANGE);
  other.receive(out.map((change, i) => ({ rev: i + 1, user: 'a', username: 'a', changes: [JSON.parse(JSON.stringify(change))] })));
  const back = theirs.sheet(copy.id);
  expect(back.name).toBe('Data (2)');
  expect(back.cells.size).toBe(120000);
  expect(theirs.getValue(copy.id, 59999, 0)).toBe('Customer name number 59999');
  expect(theirs.getCell(copy.id, 2, 1).s).toEqual({ bold: true });
  expect(theirs.getValue(theirs.sheets[0].id, 0, 5)).toBe('typed after');
  // The copy is still one step to undo, after the entry typed.
  mine.undo();
  mine.undo();
  expect(mine.sheet(copy.id)).toBeUndefined();
}, 60000);
