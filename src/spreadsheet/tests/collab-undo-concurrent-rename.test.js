import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';

// Where two people change one thing at the same moment and the room puts the other's first, Undo of one's own change
// puts the other's back, not what was there before either (see collab-undo-concurrent-write). A sheet renamed by both
// at once kept the later name, as it should, but undoing that rename went back to the name the sheet had before, so
// the other person's rename was lost too. It now goes back to the other person's name.
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
}
const names = (c) => c.wb.sheets.map((s) => s.name);

it('puts back the other person\'s name when a rename made at the same moment is undone', () => {
  const room = new Room({ sheets: [{ name: 'Sales' }, { name: 'Notes' }] });
  const ana = new Client(room, 'ana'), ben = new Client(room, 'ben');
  const id = ana.wb.sheets[0].id;
  ben.wb.renameSheet(id, 'Revenue');
  ana.wb.renameSheet(id, 'Income');
  ben.push();
  ana.push(); // Ben's rename came first; Ana's lands after it and stands
  ben.pull();
  expect(names(ana)).toEqual(['Income', 'Notes']);
  expect(names(ben)).toEqual(['Income', 'Notes']);
  ana.wb.undo();
  ana.push(); ben.pull();
  expect(names(ana)).toEqual(['Revenue', 'Notes']);
  expect(names(ben)).toEqual(['Revenue', 'Notes']);
  ana.wb.redo();
  ana.push(); ben.pull();
  expect(names(ben)).toEqual(['Income', 'Notes']);
});

it('takes back a rename alone when nobody renamed the sheet meanwhile', () => {
  const room = new Room({ sheets: [{ name: 'Sales' }, { name: 'Notes' }] });
  const ana = new Client(room, 'ana'), ben = new Client(room, 'ben');
  const id = ana.wb.sheets[0].id;
  ben.wb.renameSheet(ben.wb.sheets[1].id, 'Memo');
  ana.wb.renameSheet(id, 'Income');
  ben.push(); ana.push(); ben.pull();
  ana.wb.undo();
  ana.push(); ben.pull();
  expect(names(ben)).toEqual(['Sales', 'Memo']);
});
