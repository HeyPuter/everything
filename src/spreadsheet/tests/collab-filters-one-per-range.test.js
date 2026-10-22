import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';

// A sheet keeps one filter per range: reading a sheet (a file, a draft, a newcomer's checkpoint, the snapshot an undo
// puts back) drops a second filter over the range of another. In a shared workbook two people making tables at once
// can leave a filter behind beside the one a table now has, and deleting the row between them put the two on one
// range. Every copy held both, but anyone who opened the workbook then, and anyone whose own change had to be taken
// back and put on again meanwhile, held one: the copies no longer agreed. An edit that brings two filters onto one
// range now keeps one, as reading the sheet does.
class Room {
  constructor(json) { this.initial = new Workbook(json).toJSON(); this.log = []; }
  commit(base, changes, user) {
    if (base !== this.log.length) return { ok: false, records: this.log.slice(base) };
    this.log.push({ rev: base + 1, user, username: user, changes: JSON.parse(JSON.stringify(changes)) });
    return { ok: true, records: this.log.slice(base) };
  }
}
class Client {
  constructor(room) { this.room = room; this.wb = new Workbook(JSON.parse(JSON.stringify(room.initial))); this.rep = new Replica(this.wb); this.rep.receive(room.log); }
  pull() { this.rep.receive(this.room.log.slice(this.rep.rev)); }
  async push() {
    await null; // a step outside the undo history is captured a moment later
    for (let tries = 0; tries < 10; tries++) {
      const out = this.rep.outgoing();
      if (!out.length) return;
      const res = this.room.commit(this.rep.rev, out, 'x');
      this.rep.receive(res.records);
      if (res.ok) return;
    }
  }
}
const filters = (wb) => [wb.sheets[0].filter?.range ?? null, wb.sheets[0].otherFilters.map((f) => f.range)];

it('keeps one filter per range in every copy, as a newcomer reads the workbook', async () => {
  const cells = {};
  for (let r = 0; r < 12; r++) { cells[`${r},0`] = { v: r }; cells[`${r},1`] = { v: r * 2 }; }
  const room = new Room({ sheets: [{ name: 'S', cells }] });
  const a = new Client(room), b = new Client(room);
  const s = a.wb.sheets[0].id;
  a.wb.addTable(s, { r1: 0, c1: 0, r2: 3, c2: 1 });
  await a.push();
  b.pull();
  // At the same moment: b makes a second table, a's table grows by a row.
  b.wb.addTable(s, { r1: 6, c1: 0, r2: 9, c2: 1 });
  a.wb.setInput(s, 4, 0, 'grow');
  await b.push(); await a.push(); b.pull();
  // a deletes the row its table grew by, while b types elsewhere.
  a.wb.deleteRows(s, 4, 1);
  b.wb.setInput(s, 11, 0, 'y');
  await b.push(); await a.push(); b.pull();
  const newcomer = new Client(room);
  for (const wb of [a.wb, b.wb, newcomer.wb]) {
    expect(filters(wb)).toEqual(filters(new Workbook(wb.toJSON())));
    expect(filters(wb)).toEqual(filters(a.wb));
  }
});
