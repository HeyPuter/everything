import { expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';

// A long shared workbook (200,000 cells), where someone else's edit arrives while this person's own is on its way.
function setup() {
  const book = new Workbook({ sheets: [{ name: 'Data' }, { name: 'Calc' }] });
  const [s, t] = book.sheets.map((x) => x.id);
  book.setCells(s, Array.from({ length: 200_000 }, (_, i) => ({ r: i >> 2, c: i & 3, cell: { v: i } })), 'Fill');
  book.setInput(t, 0, 0, '=SUM(Data!A1:D10)');
  const json = book.toJSON();
  const join = () => { const wb = new Workbook(structuredClone(json)); return { wb, rep: new Replica(wb) }; };
  return { join, s, t };
}

it('takes in someone else\'s edit without reading the whole workbook again while this person\'s own is pending', () => {
  const { join, s, t } = setup();
  const ana = join(), ben = join();
  const log = [];
  const commit = (who, x) => { log.push({ rev: log.length + 1, user: who, username: who, changes: structuredClone(x.rep.outgoing()) }); };
  ana.wb.setInput(s, 0, 0, '1000');
  ben.wb.setInput(s, 1, 0, '2000');
  ben.wb.setRowHeight(s, 3, 40);
  commit('ben', ben);
  const full = vi.spyOn(ana.rep, '_fullShadow');
  const started = performance.now();
  ana.rep.receive(log); // Ben's lands first: Ana's edit is taken back, his applied, hers put on again
  const took = performance.now() - started;
  expect(full).not.toHaveBeenCalled();
  expect(took).toBeLessThan(2000);
  expect(ana.wb.getValue(s, 0, 0)).toBe(1000);
  expect(ana.wb.getValue(s, 1, 0)).toBe(2000);
  // Data!A1:D10 held 0 to 39; A1 (0) and A2 (4) are now 1000 and 2000.
  expect(ana.wb.getValue(t, 0, 0)).toBe(780 - 0 - 4 + 1000 + 2000);
  // What Ana does next is told apart from what is already shared: only her new edits travel.
  commit('ana', ana);
  ana.rep.receive(log);
  ana.wb.setInput(s, 1, 0, '3000');
  ana.wb.setRowHeight(s, 4, 30);
  expect(ana.rep.outgoing().map((c) => c.ops)).toEqual([[{ t: 'cells', s, v: { '1,0': { v: 3000, f: null } } }], [{ t: 'lines', s, p: 'rowHeights', v: { 4: 30 } }, { t: 'lines', s, p: 'rowHeightModes', v: { 4: 'fixed' } }]]);
  ben.rep.receive(log);
  commit('ana', ana);
  ben.rep.receive(log);
  for (const [r, c] of [[0, 0], [1, 0], [2, 0]]) expect(ben.wb.getValue(s, r, c)).toBe(ana.wb.getValue(s, r, c));
  expect(ben.wb.sheets[0].rowHeights.get(3)).toBe(40);
  expect(ben.wb.sheets[0].rowHeights.get(4)).toBe(30);
}, 60_000);
