import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Replacing formulas with their values on grouped sheets wrote the active sheet's values over the same cells of the
// others: Feb's =A1+1, showing 8, became Jan's 20. Each sheet's formulas now become that sheet's own values.
it('replaces each grouped sheet’s formulas with its own values, as one undo step', () => {
  const wb = new Workbook({ sheets: [{ name: 'Jan' }, { name: 'Feb' }] });
  const [a, b] = wb.sheets.map((s) => s.id);
  wb.setInput(a, 0, 0, '10'); wb.setInput(a, 0, 1, '=A1*2');
  wb.setInput(b, 0, 0, '7'); wb.setInput(b, 0, 1, '=A1+1');
  wb.setInput(b, 1, 1, '=A1*3'); // a formula Jan has no counterpart for
  wb.groupSheets([b]);
  wb.clearHistory();
  wb.formulasToValues(a, { r1: 0, c1: 1, r2: 1, c2: 1 });
  expect(wb.getCell(a, 0, 1)).toMatchObject({ v: 20, f: null });
  expect(wb.getCell(b, 0, 1)).toMatchObject({ v: 8, f: null });
  expect(wb.getCell(b, 1, 1)).toMatchObject({ v: 21, f: null });
  expect(wb.undoLabels()).toHaveLength(1);
  wb.undo();
  expect([wb.getCell(a, 0, 1).f, wb.getCell(b, 0, 1).f, wb.getCell(b, 1, 1).f]).toEqual(['A1*2', 'A1+1', 'A1*3']);
});
