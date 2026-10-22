import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';

// In a shared workbook Undo takes back only this person's own changes, and only where nobody has changed them since.
// Undoing an inserted row deleted it whatever was in it, so a row Ana inserted and Ben then typed an entry into was
// deleted, Ben's entry with it, for everyone, as soon as Ana pressed Ctrl+Z. The rows someone else has written in
// since now stay; the rest of the insertion is taken back.
class Room {
  constructor(json) { this.initial = new Workbook(json).toJSON(); this.log = []; }
  commit(base, changes, user) {
    if (base !== this.log.length) return { ok: false, records: this.log.slice(base) };
    this.log.push({ rev: base + 1, user, username: user, changes: JSON.parse(JSON.stringify(changes)) });
    return { ok: true, records: this.log.slice(base) };
  }
}
class Client {
  constructor(room, name) { this.room = room; this.name = name; this.wb = new Workbook(JSON.parse(JSON.stringify(room.initial))); this.rep = new Replica(this.wb); this.rep.receive(room.log); }
  pull() { this.rep.receive(this.room.log.slice(this.rep.rev)); }
  push() {
    for (let tries = 0; tries < 10; tries++) {
      const out = this.rep.outgoing();
      if (!out.length) return;
      const res = this.room.commit(this.rep.rev, out, this.name);
      this.rep.receive(res.records);
      if (res.ok) return;
    }
  }
  sync() { this.push(); this.pull(); }
}
const column = (c, n = 7) => Array.from({ length: n }, (_, r) => c.wb.getValue(c.wb.sheets[0].id, r, 0));

function setup() {
  const room = new Room({ sheets: [{ name: 'S', cells: { '0,0': { v: 'a' }, '1,0': { v: 'b' }, '2,0': { v: 'c' } } }] });
  const ana = new Client(room, 'ana'), ben = new Client(room, 'ben');
  return { room, ana, ben, s: ana.wb.sheets[0].id };
}

it('keeps a row someone else typed into when its insertion is undone', () => {
  const { room, ana, ben, s } = setup();
  ana.wb.insertRows(s, 1, 2);
  ana.sync(); ben.pull();
  ben.wb.setInput(s, 2, 0, 'Ben');
  ben.sync(); ana.pull();
  expect(column(ana)).toEqual(['a', null, 'Ben', 'b', 'c', null, null]);
  ana.wb.undo();
  ana.sync(); ben.pull();
  for (const c of [ana, ben, new Client(room, 'late')]) expect(column(c)).toEqual(['a', 'Ben', 'b', 'c', null, null, null]);
  // Redo inserts again the row the undo took back.
  ana.wb.redo();
  ana.sync(); ben.pull();
  expect(column(ben)).toEqual(['a', null, 'Ben', 'b', 'c', null, null]);
});

it('still takes back an insertion nobody else wrote in', () => {
  const { ana, ben, s } = setup();
  ana.wb.insertRows(s, 1, 2);
  ana.sync(); ben.pull();
  ben.wb.setInput(s, 5, 0, 'below');
  ben.sync(); ana.pull();
  ana.wb.undo();
  ana.sync(); ben.pull();
  expect(column(ben)).toEqual(['a', 'b', 'c', 'below', null, null, null]);
});
