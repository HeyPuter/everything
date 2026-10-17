import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { conditionalRuleFormula } from '../src/core/condformat-formula.js';

// A Top/Bottom N rule ranks the range's numbers, yet any cell holding numeric text was compared with them, so
// a '100 typed as text out-topped every number. Excel ranks numbers only; so do the rule and its formula.
const range = { r1: 0, c1: 0, r2: 3, c2: 0 };
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '5'); wb.setInput(id, 1, 0, '3'); wb.setInput(id, 2, 0, "'100"); wb.setInput(id, 3, 0, '1');
  wb.setInput(id, 4, 0, "'-7");
  return { wb, id, styled: () => [0, 1, 2, 3, 4].map((r) => !!wb.conditionalStyle(id, r, 0, wb.getValue(id, r, 0))) };
}

it('top 1 and bottom 1 skip numbers stored as text', () => {
  const top = book();
  top.wb.addRule(top.id, { range, type: 'top', value: '1', style: { bg: '#ff0000' } });
  expect(top.styled()).toEqual([true, false, false, false, false]);
  const bottom = book();
  bottom.wb.addRule(bottom.id, { range: { ...range, r2: 4 }, type: 'bottom', value: '1', style: { bg: '#ff0000' } });
  expect(bottom.styled()).toEqual([false, false, false, true, false]);
});

it('the exported formula agrees', () => {
  for (const [type, expected] of [['top', [true, false, false, false, false]], ['bottom', [false, false, false, true, false]]]) {
    const { wb, id, styled } = book();
    const formula = conditionalRuleFormula({ range: { ...range, r2: 4 }, type, value: 1 });
    expect(formula).toContain('ISNUMBER(A1)');
    wb.addRule(id, { range: { ...range, r2: 4 }, type: 'formula', value: formula, style: { bg: '#ff0000' } });
    expect(styled(), type).toEqual(expected);
  }
});
