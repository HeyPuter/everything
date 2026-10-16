import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { saveScenario, showScenario } from '../src/core/scenarios.js';

// A scenario's changing cells followed Insert and Delete rows, but not Move rows/columns or a cut: showing
// the scenario afterwards wrote its values over whatever had moved into the stale addresses.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Rate', '0.05'], ['Years', '10'], ['Label', 'keep me'], ['Result', '=B1*B2']]
    .forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  saveScenario(wb, id, { name: 'High', cells: [{ r: 0, c: 1 }, { r: 1, c: 1 }], values: [0.09, 30] });
  return { wb, id };
}
const cells = (wb, id) => wb.sheet(id).scenarios.list[0].cells;

describe('scenario cells follow moved cells', () => {
  it('follows Move rows, and Show writes where the cells now are', () => {
    const { wb, id } = book();
    const before = wb.toJSON();
    wb.moveRows(id, 2, 1, 0);
    expect(cells(wb, id)).toEqual([{ r: 1, c: 1 }, { r: 2, c: 1 }]);
    showScenario(wb, id, 'High');
    expect(wb.getValue(id, 0, 1)).toBe('keep me');
    expect(wb.getValue(id, 1, 1)).toBe(0.09);
    expect(wb.getValue(id, 2, 1)).toBe(30);
    wb.undo(); wb.undo();
    expect(wb.toJSON()).toEqual(before);
  });

  it('follows Move columns', () => {
    const { wb, id } = book();
    wb.moveCols(id, 1, 1, 0);
    expect(cells(wb, id)).toEqual([{ r: 0, c: 0 }, { r: 1, c: 0 }]);
  });

  it('follows a cut block, as one undo step with the move', () => {
    const { wb, id } = book();
    const before = wb.toJSON();
    wb.moveRange(id, { r1: 0, c1: 0, r2: 1, c2: 1 }, 10, 0);
    expect(cells(wb, id)).toEqual([{ r: 10, c: 1 }, { r: 11, c: 1 }]);
    const after = wb.toJSON();
    wb.undo();
    expect(wb.toJSON()).toEqual(before);
    wb.redo();
    expect(wb.toJSON()).toEqual(after);
    const cut = book(), range = { r1: 1, c1: 1, r2: 1, c2: 1 };
    cut.wb.placeMoved(cut.id, 20, 1, cut.wb.copyRange(cut.id, range), { sheetId: cut.id, range });
    expect(cells(cut.wb, cut.id)).toEqual([{ r: 0, c: 1 }, { r: 20, c: 1 }]);
  });
});
