import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// A cut moved a validation rule only when the rule lay wholly inside the cut block, and never replaced the
// rule the destination already had: cutting one cell of a validated column left its rule behind on the
// emptied cell, and the moved value landed under the destination's rule, which then rejected it.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  ['a', 'b', 'c'].forEach((v, r) => wb.setInput(id, r, 0, v));
  wb.addValidation(id, { range: { r1: 0, c1: 0, r2: 2, c2: 0 }, type: 'list', source: 'a,b,c', strict: true });
  wb.addValidation(id, { range: { r1: 0, c1: 3, r2: 0, c2: 3 }, type: 'whole', op: 'between', value: 1, value2: 5, strict: true });
  wb.clearHistory();
  return { wb, id };
}
const type = (wb, id, r, c) => wb.validationAt(id, r, c)?.type ?? null;

describe('cut-paste carries the cut part of a validation rule', () => {
  it('moves the piece under the block and replaces the destination rule, in one undo step', () => {
    const { wb, id } = book();
    const before = wb.toJSON();
    wb.moveRange(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, 0, 3);
    expect(type(wb, id, 0, 0)).toBeNull();
    expect(type(wb, id, 1, 0)).toBe('list');
    expect(type(wb, id, 2, 0)).toBe('list');
    expect(type(wb, id, 0, 3)).toBe('list');
    expect(wb.sheet(id).validations.filter(v => v.type === 'whole')).toEqual([]);
    expect(wb.validateCell(id, 0, 3).ok).toBe(true);
    const after = wb.toJSON();
    wb.undo();
    expect(wb.toJSON()).toEqual(before);
    wb.redo();
    expect(wb.toJSON()).toEqual(after);
  });

  it('clears the destination rule even when the cut cells had none', () => {
    const { wb, id } = book();
    wb.setInput(id, 5, 5, '9');
    wb.moveRange(id, { r1: 5, c1: 5, r2: 5, c2: 5 }, 0, 3);
    expect(type(wb, id, 0, 3)).toBeNull();
  });

  it('carries the piece to another sheet, leaving the rest of the rule behind', () => {
    const { wb, id } = book();
    const other = wb.addSheet('Two').id;
    wb.addValidation(other, { range: { r1: 0, c1: 0, r2: 4, c2: 0 }, type: 'whole', op: 'between', value: 1, value2: 5 });
    const range = { r1: 1, c1: 0, r2: 1, c2: 0 };
    const before = wb.toJSON();
    wb.placeMoved(other, 2, 0, wb.copyRange(id, range), { sheetId: id, range });
    expect([0, 1, 2].map(r => type(wb, id, r, 0))).toEqual(['list', null, 'list']);
    expect([0, 1, 2, 3, 4].map(r => type(wb, other, r, 0))).toEqual(['whole', 'whole', 'list', 'whole', 'whole']);
    wb.undo();
    expect(wb.toJSON()).toEqual(before);
  });

  it('keeps a relative custom formula reading the moved cells', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.addValidation(id, { range: { r1: 0, c1: 0, r2: 2, c2: 0 }, type: 'formula', source: '=A1>0' });
    wb.moveRange(id, { r1: 1, c1: 0, r2: 1, c2: 0 }, 1, 3);
    const moved = wb.validationAt(id, 1, 3);
    expect(moved.range).toEqual({ r1: 1, c1: 3, r2: 1, c2: 3 });
    expect(moved.source).toBe('=D2>0');
    expect(wb.validationAt(id, 2, 0).source).toBe('=A3>0');
  });
});
