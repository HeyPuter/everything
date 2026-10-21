import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// A colour scale, data bar, icon set, top/bottom or duplicate rule reads its range's values, and that read listed
// every value spilled anywhere on the sheet: beside an array formula entered over the rest of the sheet (seventeen
// billion results), painting a colour scale over A1:A3 ran the tab out of memory. It reads what spills into the range.
function book() {
  const wb = new Workbook(), id = wb.activeSheetId;
  ['1', '2', '3'].forEach((v, r) => wb.setInput(id, r, 0, v));
  expect(wb.setArrayFormula(id, { r1: 0, c1: 2, r2: 1048575, c2: 16383 }, '=A1*2')).toBe(true);
  return { wb, id };
}

it('paints a colour scale beside an array over the rest of the sheet', () => {
  const { wb, id } = book();
  wb.addRule(id, { range: { r1: 0, c1: 0, r2: 2, c2: 0 }, type: 'scale', from: '#000000', to: '#ffffff' });
  expect(wb.conditionalStyle(id, 0, 0, wb.getValue(id, 0, 0))?.bg).toBe('#000000');
  expect(wb.conditionalStyle(id, 2, 0, wb.getValue(id, 2, 0))?.bg).toBe('#ffffff');
});

it('still reads the results an array spills into the rule\'s range', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 2, '=SEQUENCE(3)');
  wb.addRule(id, { range: { r1: 0, c1: 2, r2: 2, c2: 2 }, type: 'scale', from: '#000000', to: '#ffffff' });
  expect(wb.conditionalStyle(id, 1, 2, wb.getValue(id, 1, 2))?.bg).toBe('#7f7f7f');
  expect(wb.conditionalStyle(id, 2, 2, wb.getValue(id, 2, 2))?.bg).toBe('#ffffff');
});
