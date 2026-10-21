import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { refill } from '../src/core/autofill-options.js';

// Dragging the fill handle on grouped sheets wrote the active sheet's results over the same cells of the others,
// though Fill Down and Fill Series already filled each grouped sheet from its own cells: Feb's 5, 6 went on as
// Jan's 120, 130, and Feb's own formula was replaced by Jan's. The drag is now made again on each grouped sheet.
function book() {
  const wb = new Workbook({ sheets: [{ name: 'Jan' }, { name: 'Feb' }] });
  const [a, b] = wb.sheets.map((s) => s.id);
  wb.setInput(a, 0, 0, '100'); wb.setInput(a, 1, 0, '110');
  wb.setInput(b, 0, 0, '5'); wb.setInput(b, 1, 0, '6');
  wb.setInput(a, 0, 2, '=A1*2'); wb.setInput(b, 0, 2, '=A1+1');
  wb.groupSheets([b]);
  wb.clearHistory();
  const column = (id, c, n) => Array.from({ length: n }, (_, r) => wb.getValue(id, r, c));
  return { wb, a, b, column };
}

it('continues each grouped sheet’s series from its own cells, as one undo step', () => {
  const { wb, a, b, column } = book();
  wb.fill(a, { r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 3, c2: 0 });
  expect(column(a, 0, 4)).toEqual([100, 110, 120, 130]);
  expect(column(b, 0, 4)).toEqual([5, 6, 7, 8]);
  expect(wb.undoLabels()).toHaveLength(1);
  wb.undo();
  expect(column(b, 0, 4)).toEqual([5, 6, null, null]);
});

it('moves each grouped sheet’s own formula down its own rows', () => {
  const { wb, a, b, column } = book();
  wb.fill(a, { r1: 0, c1: 2, r2: 0, c2: 2 }, { r1: 0, c1: 2, r2: 1, c2: 2 });
  expect(wb.getCell(a, 1, 2).f).toBe('A2*2');
  expect(wb.getCell(b, 1, 2).f).toBe('A2+1');
  expect(column(b, 2, 2)).toEqual([6, 7]);
});

it('fills each grouped sheet again from its own cells when an Auto Fill Option is chosen', () => {
  const { wb, a, b, column } = book();
  wb.fill(a, { r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 3, c2: 0 });
  wb.undo();
  refill(wb, a, { r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 3, c2: 0 }, 'copy');
  expect(column(a, 0, 4)).toEqual([100, 110, 100, 110]);
  expect(column(b, 0, 4)).toEqual([5, 6, 5, 6]);
});

it('fills nothing when another grouped sheet is protected', () => {
  const { wb, a, b, column } = book();
  wb.setSheetProtected(b, true);
  wb.fill(a, { r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 3, c2: 0 });
  expect(column(a, 0, 4)).toEqual([100, 110, null, null]);
  expect(column(b, 0, 4)).toEqual([5, 6, null, null]);
});
