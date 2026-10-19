import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';

it('shows a row sized to fit its text, then dragged to a height, at that height for everyone', () => {
  const book = new Workbook({ sheets: [{ name: 'Plan' }] });
  const s = book.sheets[0].id;
  book.setRowHeight(s, 3, 30, { auto: true }); // fitted to wrapped text, as each screen measures it
  const json = book.toJSON();
  const ana = new Workbook(structuredClone(json)), ben = new Workbook(structuredClone(json));
  const anaRep = new Replica(ana), benRep = new Replica(ben);
  ben.setRowHeight(s, 3, 34, { auto: true }); // Ben's screen measured the text a little taller
  ana.setRowHeight(s, 3, 60);
  const log = [{ rev: 1, user: 'ana', username: 'ana', changes: anaRep.outgoing() }];
  anaRep.receive(log);
  benRep.receive(log);
  for (const wb of [ana, ben]) {
    expect(wb.sheets[0].rowHeights.get(3)).toBe(60);
    expect(wb.sheets[0].rowHeightModes.get(3)).toBe('fixed');
  }
  // Undone, the row fits its text again (each screen measures it anew).
  ana.undo();
  benRep.receive([...log, { rev: 2, user: 'ana', username: 'ana', changes: anaRep.outgoing() }]);
  for (const wb of [ana, ben]) expect(wb.sheets[0].rowHeightModes.get(3)).toBe('auto');
});
