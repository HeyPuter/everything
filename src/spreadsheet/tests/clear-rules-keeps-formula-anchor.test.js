import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { clearRules } from '../src/core/conditional-groups.js';

const bold = (wb, id, c = 0) => Array.from({ length: 10 }, (_, r) => (wb.conditionalStyle(id, r, c, wb.getValue(id, r, c))?.bold ? 1 : 0)).join('');

// A custom formula is written for its range's top-left cell. Clear Rules from Selected Cells over the top of a
// rule left the rest of it with the formula unmoved, now read from a lower corner: =A1>5 over A1:A10, cleared
// from A1:A3, had A4 testing A1, A5 testing A2 and so on, so the cells over 5 lost their format.
it('keeps each remaining cell testing itself when rules are cleared from the top of a formula rule', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  for (let r = 0; r < 10; r++) wb.setInput(id, r, 0, String(r));
  wb.addRule(id, { range: { r1: 0, c1: 0, r2: 9, c2: 0 }, type: 'formula', value: '=A1>5', style: { bold: true } });
  expect(bold(wb, id)).toBe('0000001111');
  expect(clearRules(wb, id, [{ r1: 0, c1: 0, r2: 2, c2: 0 }])).toBe(1);
  expect(wb.sheet(id).rules.map(rule => [rule.range.r1, rule.value])).toEqual([[3, '=A4>5']]);
  expect(bold(wb, id)).toBe('0000001111');
  wb.undo();
  // Cleared down the left of a block, and from the top of a data bar's condition, the same holds.
  wb.addRule(id, { range: { r1: 0, c1: 1, r2: 9, c2: 2 }, type: 'formula', value: '=$A1>5', style: { bold: true } });
  clearRules(wb, id, [{ r1: 0, c1: 1, r2: 9, c2: 1 }]);
  expect(bold(wb, id, 2)).toBe('0000001111');
  expect(bold(wb, id, 1)).toBe('0000000000');
});

it('moves a data bar condition with the rule when its top rows are cleared', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  for (let r = 0; r < 10; r++) wb.setInput(id, r, 0, String(r));
  wb.addRule(id, { range: { r1: 0, c1: 0, r2: 9, c2: 0 }, type: 'databar', barMode: 'legacy', barActiveFormula: 'A1>5', style: {} });
  clearRules(wb, id, [{ r1: 0, c1: 0, r2: 1, c2: 0 }]);
  const bars = Array.from({ length: 10 }, (_, r) => (wb.conditionalStyle(id, r, 0, wb.getValue(id, r, 0))?.bar != null ? 1 : 0)).join('');
  expect(bars).toBe('0000001111');
});
