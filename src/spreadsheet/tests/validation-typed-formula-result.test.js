import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// A formula typed into a validated cell was let through whatever it gave ("formulas are checked by their
// results", but nothing checked them): =20 went into a cell that takes whole numbers from 1 to 10, past a Stop
// alert, and =B1 past a dropdown it was not on. Excel judges a formula by its result as it is entered; so does
// the app now. A result that is an error, or a formula that cannot be worked out, still passes.
it('judges a typed formula by the result it gives in the cell', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 1, 'Done');
  wb.setInput(id, 1, 1, 'Maybe');
  wb.addValidation(id, { range: { r1: 0, c1: 0, r2: 9, c2: 0 }, type: 'whole', operator: 'between', min: 1, max: 10 });
  wb.addValidation(id, { range: { r1: 0, c1: 2, r2: 9, c2: 2 }, type: 'list', source: 'Open, Done' });
  wb.addValidation(id, { range: { r1: 0, c1: 3, r2: 9, c2: 3 }, type: 'formula', source: '=D1>100' });
  expect(wb.validateInput(id, 0, 0, '=20').ok).toBe(false);
  expect(wb.validateInput(id, 0, 0, '=2*3').ok).toBe(true);
  expect(wb.validateInput(id, 0, 0, '=SUM(4,5').ok).toBe(true); // closed as the entry will be: 9
  expect(wb.validateInput(id, 0, 0, '=SUM(40,5').ok).toBe(false);
  expect(wb.validateInput(id, 0, 2, '=B1').ok).toBe(true);
  expect(wb.validateInput(id, 0, 2, '=B2').ok).toBe(false);
  // A custom rule sees the formula's result as the value about to be entered.
  expect(wb.validateInput(id, 0, 3, '=50+60').ok).toBe(true);
  expect(wb.validateInput(id, 0, 3, '=50').ok).toBe(false);
  // Errors are the formula's own problem, as they are for a cell's computed value.
  expect(wb.validateInput(id, 0, 0, '=1/0').ok).toBe(true);
  expect(wb.validateInput(id, 0, 0, '=NOSUCHFUNCTION(').ok).toBe(true);
});
