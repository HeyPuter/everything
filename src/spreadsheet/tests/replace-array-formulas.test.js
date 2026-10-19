import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { findAll, replaceCells } from '../src/core/search.js';

// Replace wrote an array formula (Ctrl+Shift+Enter) as a single plain cell. For an array over several cells the
// workbook refused that write, and with it the whole batch: Replace all changed nothing anywhere on the sheet and
// said there was nothing to replace. An array formula is now rewritten whole, as editing it does, in the same step.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '1');
  wb.setInput(id, 1, 0, '2');
  wb.setInput(id, 0, 3, '10');
  wb.setInput(id, 1, 3, '20');
  wb.setArrayFormula(id, { r1: 0, c1: 1, r2: 1, c2: 1 }, '=A1:A2*2');
  wb.setArrayFormula(id, { r1: 0, c1: 2, r2: 0, c2: 2 }, '=SUM(A1:A2)');
  wb.setInput(id, 5, 0, 'see A1:A2');
  return { wb, id };
}

describe('Replace over array formulas', () => {
  it('rewrites each array whole along with the other matches, as one undo step', () => {
    const { wb, id } = book();
    const before = wb.toJSON();
    const matches = findAll(wb, id, 'A1:A2', {});
    expect(matches).toEqual([{ r: 0, c: 1 }, { r: 0, c: 2 }, { r: 5, c: 0 }]);
    expect(replaceCells(wb, id, matches, 'A1:A2', 'D1:D2', {})).toBe(3);
    expect(wb.getCell(id, 0, 1)).toMatchObject({ f: 'D1:D2*2', array: { rows: 2, cols: 1 } });
    expect([wb.getValue(id, 0, 1), wb.getValue(id, 1, 1)]).toEqual([20, 40]);
    expect(wb.getCell(id, 0, 2)).toMatchObject({ f: 'SUM(D1:D2)', array: { rows: 1, cols: 1 } });
    expect(wb.getValue(id, 5, 0)).toBe('see D1:D2');
    wb.undo();
    expect(wb.toJSON()).toEqual(before);
  });

  it('leaves a what-if data table alone', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, '5');
    wb.setInput(id, 2, 1, '=A1*2');
    wb.setInput(id, 3, 0, '1');
    wb.setInput(id, 4, 0, '2');
    expect(wb.createDataTable(id, { r1: 2, c1: 0, r2: 4, c2: 1 }, null, { r: 0, c: 0 }).ok).toBe(true);
    const skipped = [];
    const matches = findAll(wb, id, 'TABLE', {});
    expect(matches.length).toBe(1);
    expect(replaceCells(wb, id, matches, 'A1', 'A2', { skipped })).toBe(0);
    expect(skipped).toEqual([{ ...matches[0], reason: 'formula' }]);
  });
});
