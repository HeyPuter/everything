import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';

// Grouping rows, or collapsing and expanding a group, was recorded as a structural step: a snapshot of every cell
// on the sheet, for a change to its outline alone. On a large sheet each click took a third of a second, and the
// snapshot, weighed against the history's budget, pushed every older step out: after expanding a group the edit
// typed just before could no longer be undone.

function bigBook(rows = 1000, cols = 10) {
  const cells = {};
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells[`${r},${c}`] = { v: r * cols + c };
  const wb = new Workbook({ sheets: [{ name: 'Data', rows, cols, cells }] });
  return { wb, id: wb.activeSheetId };
}

it('keeps the steps before an outline change in the history of a large sheet', () => {
  const { wb, id } = bigBook();
  wb._snapshotBudget = 5000; // the budget scaled down with the sheet: 10,000 cells stand for a million
  wb.setInput(id, 0, 0, 'Edited');
  wb.groupLines(id, 'row', 5, 20);
  wb.toggleGroup(id, 'row', 5, 20);
  wb.toggleGroup(id, 'row', 5, 20);
  expect(wb.undoLabels(10)).toEqual(['Expand rows', 'Collapse rows', 'Group rows', 'Edit cell']);
  expect(wb.undoSteps(4)).toBe(4);
  expect(wb.getValue(id, 0, 0)).toBe(0);
});

it('undoes and redoes grouping, collapsing and expanding exactly', () => {
  const { wb, id } = bigBook(40, 3);
  wb.setHidden(id, 'row', [30], true);
  const sheet = () => wb.sheet(id);
  const states = [];
  const snap = () => JSON.stringify({ groups: sheet().groups, rows: [...sheet().hiddenRows].sort((a, b) => a - b), cols: [...sheet().hiddenCols].sort((a, b) => a - b) });
  states.push(snap());
  wb.groupLines(id, 'row', 2, 10); states.push(snap());
  wb.groupLines(id, 'row', 4, 6); states.push(snap());
  wb.groupLines(id, 'col', 0, 1); states.push(snap());
  wb.toggleGroup(id, 'row', 4, 6); states.push(snap());
  wb.setAllGroups(id, 'row', true); states.push(snap());
  wb.toggleGroup(id, 'col', 0, 1); states.push(snap());
  wb.ungroupLines(id, 'row', 2, 10); states.push(snap());
  expect(sheet().hiddenRows.has(5)).toBe(false); // the removed groups' lines come back
  expect(sheet().hiddenRows.has(30)).toBe(true); // a row hidden by hand stays hidden
  for (let i = states.length - 2; i >= 0; i--) { wb.undo(); expect(snap()).toBe(states[i]); }
  for (let i = 1; i < states.length; i++) { wb.redo(); expect(snap()).toBe(states[i]); }
});

it('works SUBTOTAL out again over the rows a collapsed group hides', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (let r = 0; r < 4; r++) wb.setInput(id, r, 0, String(r + 1));
  wb.setInput(id, 5, 0, '=SUBTOTAL(109,A1:A4)');
  expect(wb.getValue(id, 5, 0)).toBe(10);
  wb.groupLines(id, 'row', 1, 2);
  wb.toggleGroup(id, 'row', 1, 2);
  expect(wb.getValue(id, 5, 0)).toBe(5);
  wb.undo();
  expect(wb.getValue(id, 5, 0)).toBe(10);
});

it('shares an outline change with the others in a shared workbook, and its undo', () => {
  const log = [];
  const initial = new Workbook({ sheets: [{ name: 'Sheet1' }] }).toJSON();
  const join = () => { const wb = new Workbook(JSON.parse(JSON.stringify(initial))); const rep = new Replica(wb); rep.receive([]); return { wb, rep }; };
  const sync = ({ rep }) => {
    const out = rep.outgoing();
    if (out.length) log.push({ rev: log.length + 1, user: 'u', username: 'u', changes: JSON.parse(JSON.stringify(out)) });
    rep.receive(log.slice(rep.rev));
  };
  const alice = join(), bob = join();
  const a = alice.wb.activeSheetId;
  alice.wb.groupLines(a, 'row', 2, 5);
  alice.wb.toggleGroup(a, 'row', 2, 5);
  sync(alice); sync(bob);
  const b = bob.wb.activeSheetId;
  expect(bob.wb.sheet(b).groups.rows).toEqual([{ from: 2, to: 5, collapsed: true }]);
  expect([...bob.wb.sheet(b).hiddenRows].sort()).toEqual([2, 3, 4, 5]);
  alice.wb.undo();
  sync(alice); sync(bob);
  expect(bob.wb.sheet(b).groups.rows).toEqual([{ from: 2, to: 5, collapsed: false }]);
  expect(bob.wb.sheet(b).hiddenRows.size).toBe(0);
});
