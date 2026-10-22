import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { findList, findRecord, matchesCriterion } from '../src/core/data-form.js';

// The Data Form's Criteria read a comparison's operand as a typed entry is read, so a date or an amount
// written as the cells show it is the number it stands for: ">2/1/2024" found no record at all, the
// operand being taken for text that no date (a number underneath) could be compared with.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Date', 'Amount'], ['1/5/2024', '$1,500.00'], ['3/5/2024', '$500.00'], ['6/1/2024', '25%']]
    .forEach((row, r) => row.forEach((text, c) => wb.setInput(id, r, c, text)));
  return { wb, id, list: findList(wb, id, 0, 0) };
}

describe('data form criteria on dates and amounts', () => {
  it('compares dates typed as dates', () => {
    const { wb, list } = book();
    expect(findRecord(wb, list, -1, 1, { 0: '>2/1/2024' })).toBe(1);
    expect(findRecord(wb, list, -1, 1, { 0: '<=3/5/2024' })).toBe(0);
    expect(findRecord(wb, list, 0, 1, { 0: '<=3/5/2024' })).toBe(1);
    expect(findRecord(wb, list, -1, 1, { 0: '=6/1/2024' })).toBe(2);
    expect(findRecord(wb, list, -1, 1, { 0: '1/5/2024' })).toBe(0);
  });

  it('compares amounts typed with a currency sign, grouping or a percent sign', () => {
    const { wb, list } = book();
    expect(findRecord(wb, list, -1, 1, { 1: '>$1,000' })).toBe(0);
    expect(findRecord(wb, list, 0, 1, { 1: '>$1,000' })).toBe(-1);
    expect(findRecord(wb, list, -1, 1, { 1: '=25%' })).toBe(2);
  });

  it('keeps text criteria and wildcards as they were', () => {
    expect(matchesCriterion('Banana', 'Banana', 'b*a')).toBe(true);
    expect(matchesCriterion('Banana', 'Banana', '>Apple')).toBe(true);
    expect(matchesCriterion(1500, '1500', '15')).toBe(true);
    expect(matchesCriterion(true, 'TRUE', '>1')).toBe(false);
  });
});
