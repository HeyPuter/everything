import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';
import { validateChange } from '../src/collab/ops.js';

// In a shared workbook Undo takes back a change with its inverse. The inverse of moving rows was the opposite move
// alone, which cannot tell that a row moved into a conditional format's or a validation rule's rows was not one of
// them: moving a row into B6:B8 and pressing Undo left both rules on the one row moved back (B4), off B6:B8, for
// everyone. On a workbook of one's own Undo put them back as they were.
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

it('puts conditional formats and validation back where they were when a row move is undone', () => {
  const room = new Room({ sheets: [{ name: 'Sheet1' }] });
  const ann = room.join('ann'), bob = room.join('bob');
  const s = ann.wb.activeSheetId;
  for (let r = 0; r < 10; r++) ann.wb.setInput(s, r, 1, String(r + 1));
  ann.wb.addRule(s, { type: 'cellIs', op: 'gt', value: '3', range: { r1: 5, c1: 1, r2: 7, c2: 1 }, style: { bold: true } });
  ann.wb.addValidation(s, { type: 'whole', op: 'between', value: '1', value2: '9', range: { r1: 5, c1: 1, r2: 7, c2: 1 } });
  ann.sync(); bob.sync();
  const B6toB8 = { r1: 5, c1: 1, r2: 7, c2: 1 };
  ann.wb.moveRows(s, 3, 1, 7);
  expect(ann.wb.sheet(s).rules[0].range).not.toEqual(B6toB8);
  ann.wb.undo();
  for (const who of [ann, bob]) { who.sync(); }
  ann.sync();
  for (const who of [ann, bob]) {
    expect(who.wb.sheet(s).rules[0].range).toEqual(B6toB8);
    expect(who.wb.sheet(s).validations[0].range).toEqual(B6toB8);
    expect(who.wb.getValue(s, 3, 1)).toBe(4);
  }
  // Redo moves the row into the rules again, as the move did.
  ann.wb.redo();
  ann.sync(); bob.sync();
  for (const who of [ann, bob]) expect(who.wb.sheet(s).rules[0].range).toEqual({ r1: 4, c1: 1, r2: 7, c2: 1 });
});

it('leaves a table as it was when an inserted row above it is undone', () => {
  const room = new Room({ sheets: [{ name: 'Sheet1' }] });
  const ann = room.join('ann');
  const s = ann.wb.activeSheetId;
  ann.wb.addTable(s, { r1: 6, c1: 4, r2: 8, c2: 5 });
  ann.sync();
  const before = JSON.stringify(ann.wb.sheet(s).tables);
  ann.wb.insertRows(s, 5, 1);
  ann.wb.undo();
  expect(JSON.stringify(ann.wb.sheet(s).tables)).toBe(before);
});
