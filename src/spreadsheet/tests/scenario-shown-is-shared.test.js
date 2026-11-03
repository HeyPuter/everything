import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';
import { validateChange } from '../src/collab/ops.js';
import { saveScenario, showScenario } from '../src/core/scenarios.js';

// Showing a scenario wrote its values as an undo step but set the sheet's shown scenario (the one Scenario Manager
// selects, and the file's <scenarios current show>) behind the workbook's back: Undo left it set, so the book was not
// the one it had been, and in a shared workbook it never reached the others, nor the file saved from the room.

function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 1, '10');
  saveScenario(wb, id, { name: 'Low', cells: [{ r: 0, c: 1 }], values: [1] });
  saveScenario(wb, id, { name: 'High', cells: [{ r: 0, c: 1 }], values: [99] });
  return { wb, id };
}

it('takes the shown scenario back with its values on Undo', () => {
  const { wb, id } = book();
  showScenario(wb, id, 'Low');
  const before = JSON.stringify(wb.toJSON());
  showScenario(wb, id, 'High');
  expect(wb.getValue(id, 0, 1)).toBe(99);
  expect(wb.sheet(id).scenarios).toMatchObject({ current: 1, show: 1 });
  wb.undo();
  expect(JSON.stringify(wb.toJSON())).toBe(before);
  expect(wb.sheet(id).scenarios).toMatchObject({ current: 0, show: 0 });
  wb.redo();
  expect(wb.sheet(id).scenarios).toMatchObject({ current: 1, show: 1 });
});

it('shares the scenario shown in a shared workbook', () => {
  const log = [];
  const { wb: seed } = book();
  const initial = seed.toJSON();
  const join = () => {
    const wb = new Workbook(JSON.parse(JSON.stringify(initial)));
    const rep = new Replica(wb, {});
    return { wb, rep, pull: () => rep.receive(log.slice(rep.rev)) };
  };
  const a = join(), b = join();
  showScenario(a.wb, a.wb.sheets[0].id, 'Low');
  for (const ch of a.rep.outgoing()) validateChange(ch);
  log.push({ rev: 1, user: 'a', username: 'a', changes: JSON.parse(JSON.stringify(a.rep.outgoing())) });
  a.pull();
  b.pull();
  const late = join();
  late.pull();
  for (const c of [a, b, late]) {
    expect(c.wb.getValue(c.wb.sheets[0].id, 0, 1)).toBe(1);
    expect(c.wb.sheets[0].scenarios).toMatchObject({ current: 0, show: 0 });
  }
});
