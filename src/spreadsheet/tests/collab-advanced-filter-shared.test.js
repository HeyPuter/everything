import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';
import { validateChange } from '../src/collab/ops.js';
import { advancedFilter, clearSheetFilters, reapplySheetFilters, sheetHasFiltering } from '../src/core/advanced-filter.js';

// A room in memory: the ordered log a room worker keeps, accepting a commit only on top of its latest record.
class Room {
  constructor(json) { this.initial = new Workbook(json).toJSON(); this.log = []; }
  since(rev) { return this.log.slice(rev); }
  commit(base, changes, user) {
    for (const ch of changes) validateChange(ch);
    if (base !== this.log.length) return { ok: false, records: this.since(base) };
    this.log.push({ rev: base + 1, user, username: user, changes: JSON.parse(JSON.stringify(changes)) });
    return { ok: true, records: this.since(base) };
  }
  join(name) { return new Client(this, name); }
}

class Client {
  constructor(room, name) {
    this.room = room;
    this.name = name;
    this.wb = new Workbook(JSON.parse(JSON.stringify(room.initial)));
    this.rep = new Replica(this.wb, {});
    this.rep.receive(room.since(0));
  }
  get sheet() { return this.wb.sheets[0].id; }
  pull() { this.rep.receive(this.room.since(this.rep.rev)); }
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
}

const rows = [['Name', 'Qty', null, 'Name'], ['a', 1, null, 'a'], ['b', 2], ['a', 3], ['c', 4]];
const cells = Object.fromEntries(rows.flatMap((row, r) => row.map((v, c) => [`${r},${c}`, v == null ? null : { v }]).filter(([, cell]) => cell)));
const LIST = { r1: 0, c1: 0, r2: 4, c2: 1 };
const CRITERIA = { range: { r1: 0, c1: 3, r2: 1, c2: 3 } };

// An Advanced Filter run in place in a shared workbook hid its rows for everyone, but the filter itself stayed with
// the person who ran it: for the others (and anyone joining later, or the file saved from the room) Data ▸ Clear
// said there was nothing to clear and left the rows hidden, and Reapply did nothing.
it('shares an advanced filter run in place, so the others can clear and reapply it', () => {
  const room = new Room({ sheets: [{ name: 'Sheet1', cells }] });
  const a = room.join('a'), b = room.join('b');
  advancedFilter(a.wb, a.sheet, { list: LIST, criteria: CRITERIA });
  expect([...a.wb.sheet(a.sheet).hiddenRows].sort()).toEqual([2, 4]);
  a.sync();
  b.pull();
  expect([...b.wb.sheet(b.sheet).hiddenRows].sort()).toEqual([2, 4]);
  expect(b.wb.sheet(b.sheet).advancedFilter).toEqual(a.wb.sheet(a.sheet).advancedFilter);
  expect(sheetHasFiltering(b.wb, b.sheet)).toBe(true);

  // The other person changes the criteria and reapplies the filter: everyone sees the new rows.
  b.wb.setInput(b.sheet, 1, 3, 'b');
  reapplySheetFilters(b.wb, b.sheet);
  expect([...b.wb.sheet(b.sheet).hiddenRows].sort()).toEqual([1, 3, 4]);
  b.sync();
  a.pull();
  expect([...a.wb.sheet(a.sheet).hiddenRows].sort()).toEqual([1, 3, 4]);

  // Someone joining later has it too, and clears it for everyone.
  const late = room.join('late');
  expect(late.wb.sheet(late.sheet).advancedFilter).toEqual(a.wb.sheet(a.sheet).advancedFilter);
  expect(clearSheetFilters(late.wb, late.sheet)).toBe(true);
  expect(late.wb.sheet(late.sheet).hiddenRows.size).toBe(0);
  late.sync();
  a.pull();
  b.pull();
  for (const c of [a, b]) {
    expect(c.wb.sheet(c.sheet).hiddenRows.size).toBe(0);
    expect(c.wb.sheet(c.sheet).advancedFilter).toBeUndefined();
  }
});
