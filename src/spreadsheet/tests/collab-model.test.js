import { describe, expect, it } from 'vitest';
import { Workbook, BOOK_STATE_KEYS } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';
import { BOOK_PROPS, validateChange } from '../src/collab/ops.js';

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

describe('shared workbook model', () => {
  it('keeps the book settings list in step with the workbook', () => {
    expect(BOOK_PROPS).toEqual(BOOK_STATE_KEYS);
  });

  it('merges concurrent edits to different cells', () => {
    const room = new Room();
    const a = room.join('a'), b = room.join('b');
    a.set('A1', '1');
    b.set('B1', '2');
    a.push();
    b.push();
    a.pull();
    expect(a.value('B1')).toBe(2);
    expect(b.value('A1')).toBe(1);
    converged(room, a, b);
  });

  it('settles concurrent edits to the same cell on the later one, everywhere', () => {
    const room = new Room();
    const a = room.join('a'), b = room.join('b');
    a.set('A1', 'from a');
    b.set('A1', 'from b');
    a.push();
    b.push(); // b's lands after a's
    a.pull();
    expect(a.value('A1')).toBe('from b');
    expect(b.value('A1')).toBe('from b');
    converged(room, a, b);
  });

  it('keeps a value and a format made at once on the same cell', () => {
    const room = new Room();
    const a = room.join('a'), b = room.join('b');
    a.set('A1', '42');
    b.wb.applyStyle(b.sheet, { r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true });
    b.push();
    a.push();
    b.pull();
    for (const c of [a, b]) {
      expect(c.value('A1')).toBe(42);
      expect(c.wb.getCell(c.sheet, 0, 0).s?.bold).toBe(true);
    }
    converged(room, a, b);
  });

  it('keeps different style properties set at once on the same cell', () => {
    const room = new Room();
    const a = room.join('a'), b = room.join('b');
    a.wb.applyStyle(a.sheet, { r1: 0, c1: 0, r2: 1, c2: 1 }, { italic: true });
    b.wb.applyStyle(b.sheet, { r1: 0, c1: 0, r2: 1, c2: 1 }, { bold: true });
    a.push();
    b.push();
    a.pull();
    for (const c of [a, b]) {
      expect(c.wb.getCell(c.sheet, 1, 1).s).toMatchObject({ bold: true, italic: true });
    }
    converged(room, a, b);
  });

  it('moves an edit made at the same time as a row insertion above it', () => {
    const room = new Room();
    const setup = room.join('setup');
    for (let r = 1; r <= 5; r++) setup.set(`A${r}`, String(r));
    setup.push();
    const a = room.join('a'), b = room.join('b');
    a.wb.insertRows(a.sheet, 1, 2); // two rows above row 2
    b.set('B4', 'next to 4');
    a.push();
    b.push();
    a.pull();
    for (const c of [a, b]) {
      expect(c.value('A6')).toBe(4);
      expect(c.value('B6')).toBe('next to 4');
      expect(c.value('B4')).toBe(null);
    }
    converged(room, a, b);
  });

  it('rewrites a formula typed while rows were inserted above what it reads', () => {
    const room = new Room();
    const setup = room.join('setup');
    for (let r = 1; r <= 5; r++) setup.set(`A${r}`, String(r * 10));
    setup.push();
    const a = room.join('a'), b = room.join('b');
    b.set('C1', '=SUM(A3:A5)');
    a.wb.insertRows(a.sheet, 0, 1);
    a.push();
    b.push();
    a.pull();
    for (const c of [a, b]) {
      expect(c.formula('C2')).toBe('SUM(A4:A6)');
      expect(c.value('C2')).toBe(120);
    }
    converged(room, a, b);
  });

  it('settles row insertions made at once, in either order', () => {
    const room = new Room();
    const setup = room.join('setup');
    for (let r = 1; r <= 6; r++) setup.set(`A${r}`, `r${r}`);
    setup.push();
    const a = room.join('a'), b = room.join('b');
    a.wb.insertRows(a.sheet, 2, 1);
    a.set('A3', 'a-new');
    b.wb.insertRows(b.sheet, 4, 2);
    b.set('A5', 'b-new');
    b.set('A6', 'b-new2');
    b.push();
    a.push();
    b.pull();
    for (const c of [a, b]) {
      expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map((r) => c.value(`A${r}`))).toEqual(['r1', 'r2', 'a-new', 'r3', 'r4', 'b-new', 'b-new2', 'r5', 'r6']);
    }
    converged(room, a, b);
  });

  it('settles insertions at the same row with the earlier one first', () => {
    const room = new Room();
    const a = room.join('a'), b = room.join('b');
    a.wb.insertRows(a.sheet, 0, 1);
    a.set('A1', 'a');
    b.wb.insertRows(b.sheet, 0, 1);
    b.set('A1', 'b');
    a.push();
    b.push();
    a.pull();
    for (const c of [a, b]) expect([c.value('A1'), c.value('A2')]).toEqual(['a', 'b']);
    converged(room, a, b);
  });

  it('drops an edit to a row someone else deleted, and keeps the rest in place', () => {
    const room = new Room();
    const setup = room.join('setup');
    for (let r = 1; r <= 5; r++) setup.set(`A${r}`, `r${r}`);
    setup.push();
    const a = room.join('a'), b = room.join('b');
    a.wb.deleteRows(a.sheet, 1, 2); // rows 2 and 3
    b.set('B2', 'gone');
    b.set('B5', 'kept');
    a.push();
    b.push();
    a.pull();
    for (const c of [a, b]) {
      expect([c.value('A1'), c.value('A2'), c.value('A3')]).toEqual(['r1', 'r4', 'r5']);
      expect(c.value('B3')).toBe('kept');
      expect(c.value('B2')).toBe(null);
    }
    converged(room, a, b);
  });

  it('settles a deletion against an insertion inside it', () => {
    const room = new Room();
    const setup = room.join('setup');
    for (let r = 1; r <= 6; r++) setup.set(`A${r}`, `r${r}`);
    setup.push();
    const a = room.join('a'), b = room.join('b');
    a.wb.deleteRows(a.sheet, 1, 4); // rows 2-5
    b.wb.insertRows(b.sheet, 3, 1);
    b.set('A4', 'inserted');
    b.push();
    a.push();
    b.pull();
    for (const c of [a, b]) expect([c.value('A1'), c.value('A2'), c.value('A3')]).toEqual(['r1', 'inserted', 'r6']);
    converged(room, a, b);
  });

  it('settles column insertions and deletions', () => {
    const room = new Room();
    const setup = room.join('setup');
    for (const col of 'ABCDE') setup.set(`${col}1`, col);
    setup.push();
    const a = room.join('a'), b = room.join('b');
    a.wb.insertCols(a.sheet, 1, 1);
    b.wb.deleteCols(b.sheet, 3, 1); // D
    b.set('E2', 'under E');
    a.push();
    b.push();
    a.pull();
    for (const c of [a, b]) expect(['A1', 'B1', 'C1', 'D1', 'E1'].map((r) => c.value(r))).toEqual(['A', null, 'B', 'C', 'E']);
    // b's E2 was column F as it was at first (D was gone for b), which a's insertion and b's deletion leave at F.
    for (const c of [a, b]) expect(c.value('F2')).toBe('under E');
    converged(room, a, b);
  });

  it('rewrites a formula typed against a sheet someone renamed meanwhile', () => {
    const room = new Room({ sheets: [{ name: 'Data' }, { name: 'Report' }] });
    const a = room.join('a'), b = room.join('b');
    const [data, report] = a.wb.sheets.map((s) => s.id);
    a.set('A1', '7', data);
    a.push();
    b.pull();
    a.wb.renameSheet(data, 'Inputs');
    b.set('B1', '=Data!A1*2', report);
    a.push();
    b.push();
    a.pull();
    for (const c of [a, b]) {
      expect(c.formula('B1', report)).toBe('Inputs!A1*2');
      expect(c.value('B1', report)).toBe(14);
    }
    converged(room, a, b);
  });

  it('rewrites a formula when the rename lands after it', () => {
    const room = new Room({ sheets: [{ name: 'Data' }, { name: 'Report' }] });
    const a = room.join('a'), b = room.join('b');
    const [data, report] = a.wb.sheets.map((s) => s.id);
    a.set('A1', '7', data);
    a.push();
    b.pull();
    b.set('B1', '=Data!A1*2', report);
    a.wb.renameSheet(data, 'Inputs');
    b.push();
    a.push();
    b.pull();
    for (const c of [a, b]) expect(c.formula('B1', report)).toBe('Inputs!A1*2');
    converged(room, a, b);
  });

  it('keeps the later of two renames of one sheet', () => {
    const room = new Room();
    const a = room.join('a'), b = room.join('b');
    a.wb.renameSheet(a.sheet, 'Alpha');
    b.wb.renameSheet(b.sheet, 'Beta');
    a.push();
    b.push();
    a.pull();
    for (const c of [a, b]) expect(c.wb.sheets[0].name).toBe('Beta');
    converged(room, a, b);
  });

  it('adds, moves and deletes sheets alongside edits on them', () => {
    const room = new Room({ sheets: [{ name: 'One' }, { name: 'Two' }] });
    const a = room.join('a'), b = room.join('b');
    const two = a.wb.sheets[1].id;
    const added = a.wb.addSheet('Three');
    a.set('A1', 'on three', added.id);
    a.wb.moveSheet(added.id, 0);
    b.set('A1', 'on two', two);
    b.push();
    a.push();
    b.pull();
    for (const c of [a, b]) {
      expect(c.wb.sheets.map((s) => s.name)).toEqual(['Three', 'One', 'Two']);
      expect(c.value('A1', added.id)).toBe('on three');
      expect(c.value('A1', two)).toBe('on two');
    }
    converged(room, a, b);
    a.wb.deleteSheet(two);
    b.set('B1', 'too late', two);
    a.push();
    b.push();
    for (const c of [a, b]) c.pull();
    for (const c of [a, b]) expect(c.wb.sheets.map((s) => s.name)).toEqual(['Three', 'One']);
    converged(room, a, b);
  });

  it('keeps a remote sheet addition from switching this person to it', () => {
    const room = new Room();
    const a = room.join('a'), b = room.join('b');
    a.wb.addSheet('New');
    a.push();
    b.pull();
    expect(b.wb.sheets.map((s) => s.name)).toEqual(['Sheet1', 'New']);
    expect(b.wb.activeSheetId).toBe(b.wb.sheets[0].id);
  });

  it('syncs column widths, merges and sheet settings', () => {
    const room = new Room();
    const a = room.join('a'), b = room.join('b');
    a.wb.setColWidth(a.sheet, 2, 180);
    b.wb.setColWidth(b.sheet, 4, 60);
    a.wb.mergeCells(a.sheet, { r1: 0, c1: 0, r2: 1, c2: 1 });
    b.wb.setFrozen(b.sheet, 1, 0);
    a.push();
    b.push();
    a.pull();
    for (const c of [a, b]) {
      expect(c.wb.colWidth(c.sheet, 2)).toBe(180);
      expect(c.wb.colWidth(c.sheet, 4)).toBe(60);
      expect(c.wb.sheets[0].merges).toEqual([{ r1: 0, c1: 0, r2: 1, c2: 1 }]);
      expect(c.wb.sheets[0].frozenRows).toBe(1);
    }
    converged(room, a, b);
  });

  it('moves a merge made while a row was inserted above it', () => {
    const room = new Room();
    const a = room.join('a'), b = room.join('b');
    a.wb.insertRows(a.sheet, 0, 1);
    b.wb.mergeCells(b.sheet, { r1: 2, c1: 0, r2: 3, c2: 1 });
    a.push();
    b.push();
    a.pull();
    for (const c of [a, b]) expect(c.wb.sheets[0].merges).toEqual([{ r1: 3, c1: 0, r2: 4, c2: 1 }]);
    converged(room, a, b);
  });

  it('syncs defined names', () => {
    const room = new Room();
    const a = room.join('a'), b = room.join('b');
    a.set('A1', '5');
    a.wb.defineName('Rate', 'Sheet1!$A$1');
    a.push();
    b.pull();
    b.set('B1', '=Rate*2');
    b.push();
    a.pull();
    expect(a.value('B1')).toBe(10);
    converged(room, a, b);
  });

  describe('undo', () => {
    it('takes back only this person\'s change, keeping a remote edit made since', () => {
      const room = new Room();
      const a = room.join('a'), b = room.join('b');
      a.set('A1', 'mine');
      a.push();
      b.pull();
      b.set('B1', 'theirs');
      b.push();
      a.pull();
      a.wb.undo();
      a.push();
      b.pull();
      for (const c of [a, b]) {
        expect(c.value('A1')).toBe(null);
        expect(c.value('B1')).toBe('theirs');
      }
      expect(b.wb.canUndo()).toBe(true); // b's own edit is still b's to undo
      converged(room, a, b);
    });

    it('leaves a cell someone else changed since alone', () => {
      const room = new Room();
      const a = room.join('a'), b = room.join('b');
      a.set('A1', 'mine');
      a.push();
      b.pull();
      b.set('A1', 'theirs');
      b.push();
      a.pull();
      expect(a.wb.canUndo()).toBe(true);
      a.wb.undo();
      a.push();
      b.pull();
      for (const c of [a, b]) expect(c.value('A1')).toBe('theirs');
      converged(room, a, b);
    });

    it('undoes an edit made before someone inserted rows above it, at its new place', () => {
      const room = new Room();
      const a = room.join('a'), b = room.join('b');
      a.set('A3', 'mine');
      a.push();
      b.pull();
      b.wb.insertRows(b.sheet, 0, 2);
      b.push();
      a.pull();
      expect(a.value('A5')).toBe('mine');
      a.wb.undo();
      a.push();
      b.pull();
      for (const c of [a, b]) expect(c.value('A5')).toBe(null);
      converged(room, a, b);
    });

    it('undoes a row deletion with what was on the rows, and redoes it', () => {
      const room = new Room();
      const a = room.join('a'), b = room.join('b');
      for (let r = 1; r <= 4; r++) a.set(`A${r}`, `r${r}`);
      a.set('C1', '=A2');
      a.wb.setColWidth(a.sheet, 0, 150);
      a.push();
      b.pull();
      a.wb.deleteRows(a.sheet, 1, 1);
      a.push();
      b.pull();
      expect(b.formula('C1')).toMatch(/#REF!/);
      b.set('E5', 'b was here');
      b.push();
      a.pull();
      a.wb.undo();
      a.push();
      b.pull();
      for (const c of [a, b]) {
        expect([1, 2, 3, 4].map((r) => c.value(`A${r}`))).toEqual(['r1', 'r2', 'r3', 'r4']);
        expect(c.formula('C1')).toBe('A2');
        expect(c.value('E6')).toBe('b was here');
      }
      converged(room, a, b);
      a.wb.redo();
      a.push();
      b.pull();
      for (const c of [a, b]) expect([1, 2, 3].map((r) => c.value(`A${r}`))).toEqual(['r1', 'r3', 'r4']);
      converged(room, a, b);
    });

    it('undoes a change still pending while a remote one arrives first', () => {
      const room = new Room();
      const a = room.join('a'), b = room.join('b');
      a.set('A1', 'pending');
      b.wb.insertRows(b.sheet, 0, 1);
      b.push();
      a.pull(); // a's edit is rebased below the new row
      expect(a.value('A2')).toBe('pending');
      a.wb.undo();
      expect(a.value('A2')).toBe(null);
      converged(room, a, b);
      expect(a.value('A2')).toBe(null);
    });

    it('undoes a sheet deletion with its cells and the formulas that read it', () => {
      const room = new Room({ sheets: [{ name: 'One' }, { name: 'Two' }] });
      const a = room.join('a'), b = room.join('b');
      const [one, two] = a.wb.sheets.map((s) => s.id);
      a.set('A1', '3', two);
      a.set('A1', '=Two!A1+1', one);
      a.push();
      b.pull();
      a.wb.deleteSheet(two);
      a.push();
      b.pull();
      expect(b.wb.sheets.length).toBe(1);
      a.wb.undo();
      a.push();
      b.pull();
      for (const c of [a, b]) {
        expect(c.wb.sheets.map((s) => s.name)).toEqual(['One', 'Two']);
        expect(c.value('A1', one)).toBe(4);
      }
      converged(room, a, b);
    });
  });

  it('applies a viewer\'s edit nowhere', () => {
    const room = new Room();
    const v = room.join('v', { readOnly: true });
    let refused = 0;
    v.rep.addEventListener('refused', () => refused++);
    v.set('A1', 'nope');
    expect(v.value('A1')).toBe(null);
    expect(v.rep.outgoing()).toEqual([]);
    expect(refused).toBe(1);
  });

  it('merges a long offline session on reconnect', () => {
    const room = new Room();
    const setup = room.join('setup');
    for (let r = 1; r <= 10; r++) setup.set(`A${r}`, String(r));
    setup.push();
    const a = room.join('a'), b = room.join('b');
    // a is offline: its edits queue
    a.set('B1', '=SUM(A1:A10)');
    a.wb.insertRows(a.sheet, 5, 1);
    a.set('A6', '100');
    a.wb.applyStyle(a.sheet, { r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true });
    // b keeps working online
    b.wb.insertRows(b.sheet, 0, 1);
    b.set('A1', '1000');
    b.push();
    b.wb.deleteRows(b.sheet, 10, 1); // old A10
    b.push();
    a.sync(); // back online
    b.pull();
    for (const c of [a, b]) {
      expect(c.formula('B2')).toBe('SUM(A2:A11)');
      expect(c.value('A7')).toBe(100);
      expect(c.value('B2')).toBe(1 + 2 + 3 + 4 + 5 + 100 + 6 + 7 + 8 + 9);
    }
    converged(room, a, b);
  });

  // Random sessions of three people: every operation the model knows, pushed and pulled at random moments.
  for (const seed of [7, 42, 2024, 31337]) {
    it(`converges three people editing at random (seed ${seed})`, () => {
      const room = new Room({ sheets: [{ name: 'S' }, { name: 'T' }] });
      const people = [room.join('a'), room.join('b'), room.join('c')];
      let x = seed;
      const rand = (n) => { x = (x * 1103515245 + 12345) % 2147483648; return x % n; };
      for (let step = 0; step < 220; step++) {
        const p = people[rand(3)];
        const sheets = p.wb.sheets;
        const s = sheets[rand(sheets.length)].id;
        const k = rand(26);
        if (k < 5) p.wb.setInput(s, rand(8), rand(4), rand(2) ? String(rand(100)) : rand(2) ? `=SUM(A1:A${1 + rand(8)})` : `=${p.wb.sheets[0].name}!B${1 + rand(5)}+1`);
        else if (k === 5) p.wb.insertRows(s, rand(8), 1 + rand(2));
        else if (k === 6) p.wb.deleteRows(s, rand(8), 1 + rand(2));
        else if (k === 7) p.wb.applyStyle(s, { r1: rand(8), c1: 0, r2: rand(8) + 8, c2: rand(4) }, rand(2) ? { bold: !!rand(2) } : { italic: true });
        else if (k === 8) p.wb.insertCols(s, rand(4), 1);
        else if (k === 9) p.wb.deleteCols(s, rand(4), 1);
        else if (k === 10) p.wb.setColWidth(s, rand(5), 40 + rand(100));
        else if (k === 11) p.wb.mergeCells(s, { r1: rand(6), c1: 0, r2: rand(6) + 6, c2: 1 });
        else if (k === 12) p.wb.renameSheet(s, `N${rand(50)}`);
        else if (k === 13) p.wb.moveRows(s, rand(4), 1, 5 + rand(3));
        else if (k === 14) p.wb.redo();
        else if (k === 15) p.wb.undo();
        else if (k === 16) { const added = p.wb.addSheet(`X${rand(9)}`); if (added && rand(2)) p.wb.setInput(added.id, 0, 0, 'x'); }
        else if (k === 17 && sheets.length > 2) p.wb.deleteSheet(s);
        else if (k === 18) p.wb.moveSheet(s, rand(sheets.length));
        else if (k === 19) p.wb.setNote(s, rand(6), rand(3), rand(2) ? `note ${rand(9)}` : '');
        else if (k === 20) p.wb.setHidden(s, 'row', [rand(8)], !!rand(2));
        else if (k === 21) p.wb.insertCells(s, { r1: rand(4), c1: rand(3), r2: rand(4) + 4, c2: rand(3) + 1 }, rand(2) ? 'down' : 'right');
        else if (k === 22) p.wb.deleteCells(s, { r1: rand(4), c1: rand(3), r2: rand(4) + 2, c2: rand(3) }, rand(2) ? 'up' : 'left');
        else if (k === 23) p.wb.clearRange(s, { r1: rand(6), c1: 0, r2: rand(6) + 2, c2: rand(4) });
        else if (k === 24) p.wb.defineName(`Nm${rand(5)}`, `${p.wb.sheet(s).name.match(/^[A-Za-z]\w*$/) ? p.wb.sheet(s).name : "'" + p.wb.sheet(s).name + "'"}!$A$${1 + rand(5)}`);
        else p.wb.sortRange(s, { r1: 0, c1: 0, r2: 7, c2: 3 }, rand(4), !!rand(2));
        if (rand(3) === 0) p.push();
        if (rand(3) === 0) p.pull();
      }
      converged(room, ...people);
    });
  }
});

describe('Show Changes in a shared workbook', () => {
  it('records someone else\'s edit under their name, and a rebase adds no entries of its own', () => {
    const room = new Room();
    const ana = room.join('ana'), ben = room.join('ben');
    ana.wb.changeAuthor = 'ana';
    ben.wb.changeAuthor = 'ben';
    ana.set('A1', '1');
    ben.set('B1', '2');
    ana.push();
    ben.push(); // refused at first: Ben's edit is taken back, Ana's applied, his put on again
    ana.pull();
    for (const c of [ana, ben]) {
      const history = c.wb.changeHistory.filter((e) => e.kind !== 'structure');
      expect(history.map((e) => e.kind)).toEqual(['cells', 'cells']);
      expect(history.map((e) => e.author).sort()).toEqual(['ana', 'ben']);
    }
    expect(ben.wb.changeHistory.find((e) => e.author === 'ana').sheet).toBe('Sheet1');
  });
});

describe('layout settings in a shared workbook', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  it('shares a sheet background, kept sheet views and custom views, but not the view someone is in', () => {
    const room = new Room();
    const ana = room.join('ana'), ben = room.join('ben');
    ana.wb.setSheetBackground(ana.sheet, PNG);
    ana.wb.addCustomView('Summary');
    ana.wb.newSheetView(ana.sheet);
    ana.wb.keepSheetView(ana.sheet, 'Mine');
    ana.sync();
    ben.pull();
    const sheet = ben.wb.sheet(ben.sheet);
    expect(sheet.background?.src).toBe(PNG);
    expect(ben.wb.customViews.map((v) => v.name)).toEqual(['Summary']);
    expect(sheet.sheetViews.map((v) => v.name)).toEqual(['Mine']);
    expect(sheet.personalView || null).toBeNull();
    expect(ana.wb.sheet(ana.sheet).personalView).toBeTruthy();
  });
});
