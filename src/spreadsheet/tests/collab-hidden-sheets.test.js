import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';
import { validateChange } from '../src/collab/ops.js';

// A room in memory, as in collab-model.test.js: one ordered log, a commit accepted only on top of its latest record.
function room(json) {
  const initial = new Workbook(json).toJSON();
  const log = [];
  const join = (name) => {
    const wb = new Workbook(structuredClone(initial));
    const rep = new Replica(wb);
    rep.receive(log);
    const push = () => {
      for (let tries = 0; tries < 10 && rep.outgoing().length; tries++) {
        const out = rep.outgoing();
        for (const ch of out) validateChange(ch);
        if (rep.rev === log.length) log.push({ rev: log.length + 1, user: name, username: name, changes: structuredClone(out) });
        rep.receive(log.slice(rep.rev));
      }
    };
    const pull = () => rep.receive(log.slice(rep.rev));
    return { wb, rep, push, pull };
  };
  return { join };
}
const shown = (wb) => wb.sheets.filter((s) => !s.hidden).map((s) => s.name);
const book = (wb) => { const j = wb.toJSON(); delete j.activeSheetId; for (const s of j.sheets) for (const k of ['viewSelection', 'viewOrigin', 'rows', 'cols']) delete s[k]; return j; };

it('keeps a sheet on show when two people hide the last two at once, the same for everyone', () => {
  const { join } = room({ sheets: [{ name: 'Plan' }, { name: 'Data' }, { name: 'Old', hidden: true }] });
  const ana = join('ana'), ben = join('ben');
  const [plan, data] = ana.wb.sheets.map((s) => s.id);
  ben.wb.setActiveSheet(plan);
  expect(ana.wb.setSheetHidden(data, true)).toBe(true);
  expect(ben.wb.setSheetHidden(plan, true)).toBe(true);
  ana.push();
  ben.push(); // lands after Ana's: every sheet would be hidden
  ana.pull();
  for (const x of [ana, ben, join('late')]) {
    expect(shown(x.wb)).toEqual(['Plan']);
    expect(x.wb.sheet(x.wb.activeSheetId).hidden).toBe(false);
  }
  expect(book(ana.wb)).toEqual(book(ben.wb));
  // Ben deleting the sheet in front of him now is refused (it is the only one on show), not a crash.
  expect(() => ben.wb.deleteSheet(ben.wb.activeSheetId)).not.toThrow();
  ben.push();
  ana.pull();
  expect(book(ana.wb)).toEqual(book(join('late').wb));
});

it('moves this person off a sheet someone else hid', () => {
  const { join } = room({ sheets: [{ name: 'Plan' }, { name: 'Data' }] });
  const ana = join('ana'), ben = join('ben');
  const [plan] = ana.wb.sheets.map((s) => s.id);
  ana.wb.setActiveSheet(plan);
  ben.wb.setSheetHidden(plan, true);
  ben.push();
  ana.pull();
  expect(ana.wb.sheet(plan).hidden).toBe(true);
  expect(ana.wb.sheet(ana.wb.activeSheetId).name).toBe('Data');
});
