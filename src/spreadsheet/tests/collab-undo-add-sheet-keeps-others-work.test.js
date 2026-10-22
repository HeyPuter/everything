import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';

// In a shared workbook Undo takes back only this person's own changes, and only where nobody has changed them since.
// Undoing an added sheet deleted it whatever was on it, so a sheet Ana added and Ben then filled in was deleted, Ben's
// work with it, for everyone, as soon as Ana pressed Ctrl+Z. A sheet someone else has worked on since now stays.
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
function setup() {
  const room = new Room({ sheets: [{ name: 'S' }] });
  return { room, ana: new Client(room, 'ana'), ben: new Client(room, 'ben') };
}

it('keeps a sheet someone else wrote in when its addition is undone', () => {
  const { room, ana, ben } = setup();
  const added = ana.wb.addSheet('Plan');
  ana.sync(); ben.pull();
  ben.wb.setInput(added.id, 0, 0, 'Ben');
  ben.sync(); ana.pull();
  ana.wb.undo();
  ana.sync(); ben.pull();
  for (const c of [ana, ben, new Client(room, 'late')]) {
    expect(c.wb.sheets.map((s) => s.name)).toEqual(['S', 'Plan']);
    expect(c.wb.getValue(added.id, 0, 0)).toBe('Ben');
  }
});

it('still takes back an added sheet nobody else touched', () => {
  const { ana, ben } = setup();
  ana.wb.addSheet('Plan');
  ana.sync(); ben.pull();
  ben.wb.setInput(ben.wb.sheets[0].id, 0, 0, 'elsewhere');
  ben.sync(); ana.pull();
  ana.wb.undo();
  ana.sync(); ben.pull();
  expect(ben.wb.sheets.map((s) => s.name)).toEqual(['S']);
});
