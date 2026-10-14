import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';
import { validateChange } from '../src/collab/ops.js';
import { newSmartArt, addSmartArtItem } from '../src/core/smartart.js';

// A room in memory, as collab-model.test.js keeps one: an ordered log that accepts a commit on top of its latest record.
class Room {
  constructor() { this.initial = new Workbook({ sheets: [{ name: 'Sheet1' }] }).toJSON(); this.log = []; }
  since(rev) { return this.log.slice(rev); }
  commit(base, changes, user) {
    for (const ch of changes) validateChange(ch);
    if (base !== this.log.length) return { ok: false, records: this.since(base) };
    this.log.push({ rev: base + 1, user, username: user, changes: JSON.parse(JSON.stringify(changes)) });
    return { ok: true, records: this.since(base) };
  }
}
const join = (room, name) => {
  const wb = new Workbook(JSON.parse(JSON.stringify(room.initial)));
  const rep = new Replica(wb);
  rep.receive(room.since(0));
  const sync = () => {
    for (let i = 0; i < 10; i++) {
      const out = rep.outgoing();
      if (!out.length) break;
      const res = room.commit(rep.rev, out, name);
      rep.receive(res.records);
      if (res.ok) break;
    }
    rep.receive(room.since(rep.rev));
  };
  return { wb, sync, sheet: () => wb.sheets[0].id };
};

describe('SmartArt when editing together', () => {
  it('reaches everyone: inserted, its text, layout and colours changed, and deleted', () => {
    const room = new Room(), ann = join(room, 'ann'), bo = join(room, 'bo');
    const id = ann.wb.addChart(ann.sheet(), { ...newSmartArt('basicProcess'), anchor: { r: 1, c: 1 }, w: 400, h: 240 });
    ann.sync(); bo.sync();
    const theirs = bo.wb.sheets[0].charts[0];
    expect(theirs).toMatchObject({ id, type: 'smartart', layout: 'basicProcess' });
    const res = addSmartArtItem(theirs.items, 0, 'below', 'Kickoff');
    bo.wb.updateSmartArt(bo.sheet(), id, { items: res.items, colors: 'colorful1' });
    bo.sync(); ann.sync();
    expect(ann.wb.chartById(ann.sheet(), id)).toMatchObject({ colors: 'colorful1', items: res.items });
    ann.wb.updateSmartArt(ann.sheet(), id, { layout: 'basicCycle' });
    ann.sync(); bo.sync();
    expect(bo.wb.chartById(bo.sheet(), id).layout).toBe('basicCycle');
    bo.wb.deleteChart(bo.sheet(), id);
    bo.sync(); ann.sync();
    expect(ann.wb.sheets[0].charts).toHaveLength(0);
  });
});
