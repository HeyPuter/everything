import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';
import { validateChange } from '../src/collab/ops.js';

// In a shared workbook Undo takes a deletion of rows or columns back by inserting the lines again and writing back
// what they held. An inserted line takes the formatting of the line before it: an empty column deleted beside a bold
// one came back bold, for everyone, and a cell of it with formatting of its own came back with the neighbour's on
// top. Undo on a workbook of one's own puts the lines back as they were.
class Room {
  constructor(json) { this.initial = new Workbook(json).toJSON(); this.log = []; }
  commit(base, changes, user) {
    for (const ch of changes) validateChange(ch);
    if (base !== this.log.length) return { ok: false, records: this.log.slice(base) };
    this.log.push({ rev: base + 1, user, username: user, changes: JSON.parse(JSON.stringify(changes)) });
    return { ok: true, records: this.log.slice(base) };
  }
  join(name) {
    const wb = new Workbook(JSON.parse(JSON.stringify(this.initial)));
    const rep = new Replica(wb);
    rep.receive(this.log);
    const sync = () => {
      for (let i = 0; i < 10 && rep.outgoing().length; i++) { const res = this.commit(rep.rev, rep.outgoing(), name); rep.receive(res.records); if (res.ok) break; }
      rep.receive(this.log.slice(rep.rev));
    };
    return { wb, rep, sync };
  }
}

it('does not give a deleted column the formatting of the one before it when the deletion is undone', () => {
  const room = new Room({ sheets: [{ name: 'Sheet1' }] });
  const ann = room.join('ann'), bob = room.join('bob');
  const s = ann.wb.activeSheetId;
  ann.wb.setInput(s, 0, 3, 'Header');
  ann.wb.applyStyle(s, { r1: 0, c1: 3, r2: 3, c2: 3 }, { bold: true });
  ann.wb.setInput(s, 1, 4, 'x');
  ann.wb.applyStyle(s, { r1: 1, c1: 4, r2: 1, c2: 4 }, { italic: true });
  ann.wb.setInput(s, 0, 5, 'F');
  ann.sync(); bob.sync();
  ann.wb.deleteCols(s, 4, 1);
  ann.wb.undo();
  ann.sync(); bob.sync();
  for (const who of [ann, bob]) {
    expect(who.wb.getCell(s, 0, 4) ?? null).toBeNull();
    expect(who.wb.getCell(s, 2, 4) ?? null).toBeNull();
    expect(who.wb.getCell(s, 1, 4).s).toEqual({ italic: true });
    expect(who.wb.getCell(s, 0, 3).s).toEqual({ bold: true });
    expect(who.wb.getValue(s, 0, 5)).toBe('F');
  }
});

it('does not give a deleted row the format of the row above when the deletion is undone', () => {
  const room = new Room({ sheets: [{ name: 'Sheet1' }] });
  const ann = room.join('ann');
  const s = ann.wb.activeSheetId;
  ann.wb.applyStyle(s, { r1: 2, c1: 0, r2: 2, c2: 16383 }, { bold: true }); // all of row 3
  ann.sync();
  const before = JSON.stringify(ann.wb.toJSON().sheets[0]);
  ann.wb.deleteRows(s, 3, 2);
  ann.wb.undo();
  expect(JSON.stringify(ann.wb.toJSON().sheets[0])).toBe(before);
});
