import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';
import { validateChange } from '../src/collab/ops.js';
import { addComment, replyToThread, getThread, setThreadResolved, deleteThreadItem } from '../src/core/comments.js';

// A room in memory, as in collab-model.test.js: one ordered log, a commit accepted only on top of its latest record.
function room() {
  const initial = new Workbook({ sheets: [{ name: 'Plan' }] }).toJSON();
  const log = [];
  const join = (name) => {
    const wb = new Workbook(structuredClone(initial));
    const rep = new Replica(wb);
    const push = () => {
      for (let tries = 0; tries < 10 && rep.outgoing().length; tries++) {
        const out = rep.outgoing();
        for (const ch of out) validateChange(ch);
        if (rep.rev === log.length) log.push({ rev: log.length + 1, user: name, username: name, changes: structuredClone(out) });
        rep.receive(log.slice(rep.rev));
      }
    };
    const pull = () => rep.receive(log.slice(rep.rev));
    return { wb, rep, push, pull, sheet: wb.sheets[0].id };
  };
  const fresh = () => { const c = join('late'); c.pull(); return c; };
  return { join, fresh };
}
const texts = (wb, s, r, c) => getThread(wb, s, r, c)?.items.map((i) => i.text) ?? null;

describe('comments made at once in a shared workbook', () => {
  it('keeps both people\'s new threads on one sheet', () => {
    const { join, fresh } = room();
    const ana = join('ana'), ben = join('ben');
    addComment(ana.wb, ana.sheet, 0, 0, 'Check this total', 'ana');
    addComment(ben.wb, ben.sheet, 4, 2, 'Source?', 'ben');
    ana.push();
    ben.push(); // lands after Ana's
    ana.pull();
    for (const x of [ana, ben, fresh()]) {
      expect(texts(x.wb, x.sheet, 0, 0)).toEqual(['Check this total']);
      expect(texts(x.wb, x.sheet, 4, 2)).toEqual(['Source?']);
    }
  });

  it('keeps both replies to one thread, and a thread resolved meanwhile', () => {
    const { join, fresh } = room();
    const ana = join('ana'), ben = join('ben');
    addComment(ana.wb, ana.sheet, 1, 1, 'Why so high?', 'ana', new Date('2026-01-01T10:00:00Z'));
    ana.push();
    ben.pull();
    replyToThread(ana.wb, ana.sheet, 1, 1, 'Also check March', 'ana', new Date('2026-01-01T10:05:00Z'));
    replyToThread(ben.wb, ben.sheet, 1, 1, 'Bonus month', 'ben', new Date('2026-01-01T10:04:00Z'));
    addComment(ben.wb, ben.sheet, 2, 2, 'Second thread', 'ben');
    ben.push();
    ana.push(); // Ana's reply lands after Ben's
    ben.pull();
    const late = fresh();
    for (const x of [ana, ben, late]) {
      expect(texts(x.wb, x.sheet, 1, 1)).toEqual(['Why so high?', 'Bonus month', 'Also check March']);
      expect(texts(x.wb, x.sheet, 2, 2)).toEqual(['Second thread']);
    }
    // A reply deleted on one side while the other resolves the thread: both happen.
    const thread = getThread(ana.wb, ana.sheet, 1, 1);
    deleteThreadItem(ana.wb, ana.sheet, 1, 1, thread.items[1].id);
    setThreadResolved(ben.wb, ben.sheet, 1, 1, true);
    ana.push();
    ben.push();
    ana.pull();
    for (const x of [ana, ben, fresh()]) {
      expect(texts(x.wb, x.sheet, 1, 1)).toEqual(['Why so high?', 'Also check March']);
      expect(getThread(x.wb, x.sheet, 1, 1).done).toBe(true);
    }
  });

  it('keeps a thread someone deleted gone, and a later edit of one pending change on top of another', () => {
    const { join, fresh } = room();
    const ana = join('ana'), ben = join('ben');
    addComment(ana.wb, ana.sheet, 0, 0, 'Old note', 'ana');
    ana.push();
    ben.pull();
    // Ben deletes the thread; Ana, offline, adds two threads one after the other (two pending changes).
    deleteThreadItem(ben.wb, ben.sheet, 0, 0, getThread(ben.wb, ben.sheet, 0, 0).items[0].id);
    ben.push();
    addComment(ana.wb, ana.sheet, 3, 0, 'First', 'ana');
    addComment(ana.wb, ana.sheet, 5, 0, 'Second', 'ana');
    expect(ana.rep.pending.length).toBe(2);
    ana.push();
    ben.pull();
    for (const x of [ana, ben, fresh()]) {
      expect(texts(x.wb, x.sheet, 0, 0)).toBe(null);
      expect(texts(x.wb, x.sheet, 3, 0)).toEqual(['First']);
      expect(texts(x.wb, x.sheet, 5, 0)).toEqual(['Second']);
    }
  });
});

describe('objects, rules and merges added at once to one sheet of a shared workbook', () => {
  it('keeps both people\'s text boxes, pictures and charts, and an object deleted meanwhile stays deleted', () => {
    const { join, fresh } = room();
    const ana = join('ana'), ben = join('ben');
    const old = ana.wb.addChart(ana.sheet, { type: 'text', text: 'Old', anchor: { r: 1, c: 1 }, w: 120, h: 40 });
    ana.push();
    ben.pull();
    ana.wb.addChart(ana.sheet, { type: 'text', text: 'From Ana', anchor: { r: 5, c: 5 }, w: 120, h: 40 });
    ben.wb.addChart(ben.sheet, { type: 'text', text: 'From Ben', anchor: { r: 9, c: 1 }, w: 120, h: 40 });
    ben.wb.deleteChart(ben.sheet, old);
    ben.push();
    ana.push();
    ben.pull();
    for (const x of [ana, ben, fresh()]) expect(x.wb.sheets[0].charts.map((c) => c.text).sort()).toEqual(['From Ana', 'From Ben']);
  });

  it('keeps both people\'s conditional formats and validation', () => {
    const { join, fresh } = room();
    const ana = join('ana'), ben = join('ben');
    ana.wb.addRule(ana.sheet, { type: 'gt', range: { r1: 0, c1: 0, r2: 9, c2: 0 }, value: 5, style: { bold: true } });
    ben.wb.addRule(ben.sheet, { type: 'lt', range: { r1: 0, c1: 2, r2: 9, c2: 2 }, value: 0, style: { italic: true } });
    ana.wb.addValidation(ana.sheet, { type: 'whole', operator: 'between', min: '1', max: '10', range: { r1: 0, c1: 0, r2: 4, c2: 0 } });
    ben.wb.addValidation(ben.sheet, { type: 'list', source: 'Yes,No', range: { r1: 0, c1: 3, r2: 4, c2: 3 } });
    ana.push();
    ben.push();
    ana.pull();
    for (const x of [ana, ben, fresh()]) {
      expect(x.wb.sheets[0].rules.map((r) => r.type)).toEqual(['gt', 'lt']);
      expect(x.wb.sheets[0].validations.map((v) => v.type)).toEqual(['whole', 'list']);
    }
  });

  it('keeps cells both people merged, but not two merges over the same cells', () => {
    const { join, fresh } = room();
    const ana = join('ana'), ben = join('ben');
    ana.wb.mergeCells(ana.sheet, { r1: 0, c1: 0, r2: 0, c2: 3 });
    ana.wb.mergeCells(ana.sheet, { r1: 4, c1: 0, r2: 4, c2: 1 });
    ben.wb.mergeCells(ben.sheet, { r1: 2, c1: 0, r2: 2, c2: 3 });
    ben.wb.mergeCells(ben.sheet, { r1: 0, c1: 2, r2: 1, c2: 4 }); // overlaps Ana's
    ana.push();
    ben.push(); // lands later: its merge over Ana's cells stands, Ana's gives way
    ana.pull();
    for (const x of [ana, ben, fresh()]) {
      expect(x.wb.sheets[0].merges.map(({ r1, c1, r2, c2 }) => `${r1},${c1}:${r2},${c2}`).sort()).toEqual(['0,2:1,4', '2,0:2,3', '4,0:4,1']);
    }
  });
});

