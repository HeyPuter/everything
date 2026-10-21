import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';
import { validateChange } from '../src/collab/ops.js';

// A room in memory: the ordered log a room worker keeps, accepting a commit only on top of its latest record.
class Room {
  constructor(json = { sheets: [{ name: 'Sheet1' }] }) { this.initial = new Workbook(json).toJSON(); this.log = []; }
  since(rev) { return this.log.slice(rev); }
  commit(base, changes, user) {
    for (const ch of changes) validateChange(ch);
    if (base !== this.log.length) return { ok: false, records: this.since(base) };
    this.log.push({ rev: base + 1, user, username: user, changes: JSON.parse(JSON.stringify(changes)) });
    return { ok: true, records: this.since(base) };
  }
  join(name, options) { return new Client(this, name, options); }
}

class Client {
  constructor(room, name, { readOnly = false } = {}) {
    this.room = room;
    this.name = name;
    this.wb = new Workbook(JSON.parse(JSON.stringify(room.initial)));
    this.rep = new Replica(this.wb, { readOnly });
    this.rep.receive(room.since(0));
  }
  get sheet() { return this.wb.sheets[0].id; }
  pull() { this.rep.receive(this.room.since(this.rep.rev)); }
  /** Send what is pending; a refusal (someone was first) rebases and sends again. */
  push() {
    for (let tries = 0; tries < 10; tries++) {
      const out = this.rep.outgoing();
      if (!out.length) return;
      const res = this.room.commit(this.rep.rev, out, this.name);
      this.rep.receive(res.records);
      if (res.ok) return;
    }
    throw new Error('push did not settle');
  }
  sync() { this.push(); this.pull(); }
  value(ref, sheet = this.wb.sheets[0].id) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    const c = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    return this.wb.getValue(sheet, Number(m[2]) - 1, c);
  }
  formula(ref, sheet = this.wb.sheets[0].id) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    const c = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    return this.wb.getCell(sheet, Number(m[2]) - 1, c)?.f ?? null;
  }
  set(ref, text, sheet = this.wb.sheets[0].id) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    const c = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    this.wb.setInput(sheet, Number(m[2]) - 1, c, text);
  }
}

/** What everyone must agree on: the workbook as a file holds it, without anyone's view. */
function state(wb) {
  const json = wb.toJSON();
  delete json.activeSheetId;
  delete json.workbookView;
  for (const s of json.sheets) for (const k of ['viewZoom', 'viewMode', 'viewSelection', 'viewOrigin', 'split', 'rows', 'cols', 'filterHidden']) delete s[k];
  return json;
}

function converged(room, ...clients) {
  for (const c of clients) c.sync();
  for (const c of clients) c.pull();
  const fresh = room.join('late');
  for (const c of clients) expect(state(c.wb)).toEqual(state(fresh.wb));
  return fresh;
}

// Two people change the same thing at once; the room puts the other person's change first, so this person's lands
// on top of it. Undo took this person's change back to what the thing held before either of them, wiping out the
// other person's change too, in every browser: Undo now goes back to what this person's change replaced.
describe('undoing a change made at the same time as someone else\'s to the same thing', () => {
  it('puts back the other person\'s entry in the cell, not an empty one', () => {
    const room = new Room();
    const a = room.join('a'), b = room.join('b');
    a.set('A1', 'mine');
    b.set('A1', 'theirs');
    b.push();
    a.sync();
    b.pull();
    for (const c of [a, b]) expect(c.value('A1')).toBe('mine');
    a.wb.undo();
    a.push();
    b.pull();
    for (const c of [a, b]) expect(c.value('A1')).toBe('theirs');
    converged(room, a, b);
  });

  it('puts back the other person\'s fill colour', () => {
    const room = new Room();
    const a = room.join('a'), b = room.join('b');
    a.wb.applyStyle(a.sheet, { r1: 0, c1: 0, r2: 0, c2: 0 }, { bg: '#0000ff' });
    b.wb.applyStyle(b.sheet, { r1: 0, c1: 0, r2: 0, c2: 0 }, { bg: '#ff0000' });
    b.push();
    a.sync();
    b.pull();
    a.wb.undo();
    a.push();
    b.pull();
    for (const c of [a, b]) expect(c.wb.getCell(c.sheet, 0, 0)?.s?.bg).toBe('#ff0000');
    converged(room, a, b);
  });

  it('puts back the other person\'s column width', () => {
    const room = new Room();
    const a = room.join('a'), b = room.join('b');
    a.wb.setColWidth(a.sheet, 1, 200);
    b.wb.setColWidth(b.sheet, 1, 140);
    b.push();
    a.sync();
    b.pull();
    a.wb.undo();
    a.push();
    b.pull();
    for (const c of [a, b]) expect(c.wb.sheet(c.sheet).colWidths.get(1)).toBe(140);
    converged(room, a, b);
  });
});
