import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica, splitChange } from '../src/collab/replica.js';
import { MAX_CHANGE, MAX_OPS, validateChange } from '../src/collab/ops.js';

// Deleting the rows a filter shows deletes each run of shown rows separately, and the room takes at most 100,000 runs
// in one deletion. Deleting every other row of a list of 200,002 (100,001 runs) made a deletion the room refused for
// good, so the change was taken back here and the rows came back. Such a deletion now travels as several, each within
// what the room takes, the lowest rows first so that each one's positions still hold.
it('sends a deletion of more than 100,000 separate runs of rows as deletions the room takes', async () => {
  const n = 200002;
  const cells = {};
  for (let r = 0; r < n; r++) cells[`${r},0`] = { v: r };
  const json = new Workbook({ sheets: [{ name: 'S', rows: n, cells }] }).toJSON();
  const mine = new Workbook(JSON.parse(JSON.stringify(json))), theirs = new Workbook(JSON.parse(JSON.stringify(json)));
  const rep = new Replica(mine), other = new Replica(theirs);
  const s = mine.sheets[0].id;
  const evens = [];
  for (let r = 0; r < n; r += 2) evens.push({ from: r, to: r });
  mine.deleteLines(s, 'row', evens);
  await null;
  const out = rep.outgoing();
  for (const change of out) {
    expect(JSON.stringify(change).length).toBeLessThanOrEqual(MAX_CHANGE);
    expect(() => validateChange(JSON.parse(JSON.stringify(change)))).not.toThrow();
  }
  const records = out.map((change, i) => ({ rev: i + 1, user: 'a', username: 'a', changes: [JSON.parse(JSON.stringify(change))] }));
  rep.receive(records);
  other.receive(records);
  expect(rep.pending).toEqual([]);
  for (const wb of [mine, theirs]) {
    expect(wb.sheet(s).cells.size).toBe(n / 2);
    expect([wb.getValue(s, 0, 0), wb.getValue(s, 1, 0), wb.getValue(s, 60000, 0), wb.getValue(s, n / 2 - 1, 0)]).toEqual([1, 3, 120001, n - 1]);
  }
  // It stays one step to undo, which puts every row back with what was on it.
  expect(mine.undoLabels().length).toBe(1);
});

it('sends an undo that puts back more runs of rows than a change carries operations in parts', () => {
  const ops = [], inverses = [];
  for (let r = 0; r < 50000; r++) { ops.push({ t: 'insert', s: 'x', axis: 'row', at: 2 * r, n: 1 }); inverses.push([{ t: 'delete', s: 'x', axis: 'row', runs: [{ from: 2 * r, to: 2 * r }] }]); }
  const parts = splitChange(ops, inverses);
  expect(parts?.length).toBeGreaterThan(1);
  expect(parts.flatMap((p) => p.ops)).toEqual(ops);
  for (const p of parts) {
    expect(p.ops.length).toBeLessThanOrEqual(MAX_OPS);
    expect(JSON.stringify(p.ops).length).toBeLessThanOrEqual(MAX_CHANGE);
  }
});
