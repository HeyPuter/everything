import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';
import { transformStructure } from '../src/collab/ops.js';

// Deleting the rows a filter shows deletes thousands of separate runs of rows at once. Two people doing so at the same
// moment in a shared workbook held the page of the one whose change came second while it was rebased: every position
// mapped through the other deletion merged its runs anew, and the undo of one's own deletion (an insertion per run)
// was taken by a recursion that copied the rest of the list at every step. For 20,000 rows: 10.5 s -> 1.4 s to take the
// other's change, and the two deletions transformed against each other alone 4.7 s -> 7 ms.
it('transforms two deletions of thousands of runs against each other at once', () => {
  const a = { t: 'delete', s: 'x', axis: 'row', runs: [] }, b = { t: 'delete', s: 'x', axis: 'row', runs: [] };
  for (let r = 0; r < 20000; r += 2) a.runs.push({ from: r, to: r });
  for (let r = 1; r < 20000; r += 3) b.runs.push({ from: r, to: r });
  const start = performance.now();
  const [[a2], [b2]] = transformStructure(a, b, true);
  expect(performance.now() - start).toBeLessThan(1000);
  // After b, a's rows 0 and 2 are rows 0 and 1 (b took row 1); after a, b's row 1 is row 0, and its row 4, which a
  // deletes too, is deleted once.
  expect(a2.runs[0]).toEqual({ from: 0, to: 1 });
  expect(b2.runs.slice(0, 2)).toEqual([{ from: 0, to: 0 }, { from: 3, to: 3 }]);
  expect(a2.runs.length + b2.runs.length).toBeLessThan(a.runs.length + b.runs.length);
});

it('rebases a deletion of filtered rows over another made at the same moment, quickly and once per row', async () => {
  const n = 12000;
  const cells = {};
  for (let r = 0; r < n; r++) cells[`${r},0`] = { v: r };
  const json = new Workbook({ sheets: [{ name: 'S', rows: n, cells }] }).toJSON();
  const [A, B] = [0, 1].map(() => { const wb = new Workbook(JSON.parse(JSON.stringify(json))); return { wb, rep: new Replica(wb) }; });
  const s = A.wb.sheets[0].id;
  const evens = [], thirds = [];
  for (let r = 0; r < n; r += 2) evens.push({ from: r, to: r });
  for (let r = 1; r < n; r += 3) thirds.push({ from: r, to: r });
  B.wb.deleteLines(s, 'row', evens);
  A.wb.deleteLines(s, 'row', thirds);
  await null;
  const start = performance.now();
  A.rep.receive([{ rev: 1, user: 'b', username: 'b', changes: JSON.parse(JSON.stringify(B.rep.outgoing())) }]);
  expect(performance.now() - start).toBeLessThan(1000);
  // What is left: the rows neither deleted, in order.
  const kept = [];
  for (let r = 0; r < n; r++) if (r % 2 && r % 3 !== 1) kept.push(r);
  B.rep.receive([{ rev: 1, user: 'b', username: 'b', changes: JSON.parse(JSON.stringify(B.rep.outgoing())) }, { rev: 2, user: 'a', username: 'a', changes: JSON.parse(JSON.stringify(A.rep.outgoing())) }]);
  for (const { wb } of [A, B]) expect(Array.from({ length: kept.length }, (_, i) => wb.getValue(s, i, 0))).toEqual(kept);
}, 60000);
