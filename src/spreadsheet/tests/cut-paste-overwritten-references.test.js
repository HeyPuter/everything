import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { packedMoveReferences } from '../src/core/packed-move-refs.js';

// Moving a block onto cells other formulas read destroyed those cells' values, but the formulas went on
// reading whatever landed there. Excel turns a reference wholly inside the overwritten cells into #REF!;
// one into the moved block still follows it, and a range only partly over the destination is left alone.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '5');
  wb.setInput(id, 1, 0, '7');
  wb.setInput(id, 2, 0, '9');
  wb.setInput(id, 0, 2, '=A2*10');
  wb.setInput(id, 1, 2, '=A1+1');
  wb.setInput(id, 2, 2, '=SUM(A2:A3)');
  const other = wb.addSheet('Report').id;
  wb.setInput(other, 0, 0, '=Sheet1!A2');
  wb.setActiveSheet(id);
  wb.defineName('Kept', 'Sheet1!$A$2');
  return { wb, id, other };
}

describe('cut-paste over referenced cells', () => {
  it('turns references to the overwritten cells into #REF! and keeps the rest, in one undo step', () => {
    const { wb, id, other } = book();
    const before = wb.toJSON();
    wb.moveRange(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, 1, 0);
    expect(wb.getCell(id, 0, 2).f).toBe('#REF!*10');
    expect(wb.getValue(id, 0, 2)).toEqual({ error: '#REF!' });
    expect(wb.getCell(other, 0, 0).f).toBe('#REF!');
    expect(wb.names.find(n => n.name === 'Kept').ref).toBe('#REF!');
    // A reference to the moved cell follows it; a range only partly over the destination stays.
    expect(wb.getCell(id, 1, 2).f).toBe('A2+1');
    expect(wb.getValue(id, 1, 2)).toBe(6);
    expect(wb.getCell(id, 2, 2).f).toBe('SUM(A2:A3)');
    wb.undo();
    expect(wb.toJSON()).toEqual(before);
  });

  it('does the same when a cut is pasted, also from another sheet, and in a moved formula', () => {
    const { wb, id, other } = book();
    wb.setInput(other, 5, 0, '=Sheet1!A3');
    const range = { r1: 5, c1: 0, r2: 5, c2: 0 };
    wb.placeMoved(id, 2, 0, wb.copyRange(other, range), { sheetId: other, range });
    expect(wb.getCell(id, 2, 0).f).toBe('#REF!');
    expect(wb.getCell(id, 2, 2).f).toBe('SUM(A2:A3)');
    wb.placeMoved(id, 1, 0, wb.copyRange(id, { r1: 0, c1: 0, r2: 0, c2: 0 }), { sheetId: id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } });
    expect(wb.getCell(id, 0, 2).f).toBe('#REF!*10');
    expect(wb.getCell(id, 1, 2).f).toBe('A2+1');
  });

  it('keeps a reference into a block moved onto itself following the block', () => {
    const { wb, id } = book();
    wb.setInput(id, 5, 2, '=A1+A3');
    wb.moveRange(id, { r1: 0, c1: 0, r2: 1, c2: 0 }, 1, 0);
    // A1 moved to A2; A3 was overwritten by the old A2.
    expect(wb.getCell(id, 5, 2).f).toBe('A2+#REF!');
  });

  it('applies to a packed (filtered) cut too', () => {
    const move = packedMoveReferences('Sheet1', 'Sheet1', [0, 2], [0], 5, 0);
    expect(move.follow('A1+A3+A6+A7+A6:A8', 'Sheet1')).toBe('A6+A7+#REF!+#REF!+A6:A8');
  });
});
