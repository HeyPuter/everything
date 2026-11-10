import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// A formula hidden with Format Cells ▸ Protection ▸ Hidden on a protected sheet showed in full through
// =FORMULATEXT(A2) in any other cell (and so through anything that reads cell values, the assistant's
// calculate tool among them). Excel answers #N/A for such a cell; ISFORMULA still says it holds one.
function book() {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '2');
  wb.setInput(id, 1, 0, '=A1*7*3');
  wb.setInput(id, 0, 1, '=FORMULATEXT(A2)');
  wb.setInput(id, 1, 1, '=ISFORMULA(A2)');
  wb.applyStyle(id, { r1: 1, c1: 0, r2: 1, c2: 0 }, { formulaHidden: true });
  return { wb, id };
}

it('answers #N/A for a formula hidden on a protected sheet, and the formula once the sheet is unprotected', () => {
  const { wb, id } = book();
  expect(wb.getValue(id, 0, 1)).toBe('=A1*7*3');
  wb.setSheetProtected(id, true);
  expect(wb.getValue(id, 0, 1)).toEqual({ error: '#N/A' });
  expect(wb.getValue(id, 1, 1)).toBe(true);
  wb.setSheetProtected(id, false);
  expect(wb.getValue(id, 0, 1)).toBe('=A1*7*3');
});

it('hides it from another sheet too, and from an array formula hidden at its corner', () => {
  const { wb, id } = book();
  wb.setArrayFormula(id, { r1: 4, c1: 0, r2: 5, c2: 0 }, '={1;2}');
  wb.applyStyle(id, { r1: 4, c1: 0, r2: 5, c2: 0 }, { formulaHidden: true });
  wb.setSheetProtected(id, true);
  const other = wb.addSheet('Other').id;
  wb.setInput(other, 0, 0, '=FORMULATEXT(Sheet1!A2)');
  wb.setInput(other, 1, 0, '=FORMULATEXT(Sheet1!A6)');
  wb.setInput(other, 2, 0, '=FORMULATEXT(Sheet1!A1:A2)');
  expect(wb.getValue(other, 0, 0)).toEqual({ error: '#N/A' });
  expect(wb.getValue(other, 1, 0)).toEqual({ error: '#N/A' });
  expect([wb.getValue(other, 2, 0), wb.getValue(other, 3, 0)]).toEqual([{ error: '#N/A' }, { error: '#N/A' }]);
});
