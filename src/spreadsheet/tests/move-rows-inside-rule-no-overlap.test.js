import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange, rangeName } from '../src/core/cell.js';

// Rows moved from inside a rule to elsewhere inside it were covered twice: once by their own piece, and once more
// by the piece before where they landed, stretched over them as if they had come from outside. A Top 3 then
// ranked those rows' values twice, the rules list showed the rule twice, and a validation rule overlapped itself.
const overlapping = (list) => list.some((a, i) => list.some((b, j) => i < j && a.range.r1 <= b.range.r2 && b.range.r1 <= a.range.r2
  && a.range.c1 <= b.range.c2 && b.range.c1 <= a.range.c2));

it.each([[3, 2, 0], [0, 1, 5], [2, 2, 8]])('keeps one rule over the same cells when rows %i (+%i) move to %i inside it', (from, count, to) => {
  const wb = new Workbook(), id = wb.activeSheetId;
  for (let i = 0; i < 10; i++) wb.setInput(id, i, 2, String(i === 9 ? 95 : (i + 1) * 10));
  wb.addRule(id, { range: parseRange('C1:C10'), type: 'top', value: 2, style: { bold: true } });
  wb.addValidation(id, { range: parseRange('C1:C10'), type: 'whole', operator: 'greaterThan', min: 0 });
  wb.moveRows(id, from, count, to);
  const sheet = wb.sheet(id);
  expect(sheet.rules.map((rule) => rangeName(rule.range))).toEqual(['C1:C10']);
  expect(overlapping(sheet.validations)).toBe(false);
  const marked = [];
  for (let r = 0; r < 10; r++) if (wb.conditionalStyle(id, r, 2, wb.getValue(id, r, 2))?.bold) marked.push(wb.getValue(id, r, 2));
  expect(marked.sort((a, b) => a - b)).toEqual([90, 95]);
});

it('takes in the moved rows from outside a rule that land inside it, once', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.addRule(id, { range: parseRange('C3:C10'), type: 'notEmpty', style: { bold: true } });
  wb.moveRows(id, 0, 4, 8); // rows 1-2 from above the rule and 3-4 from inside it land inside it
  expect(overlapping(wb.sheet(id).rules)).toBe(false);
  expect(wb.sheet(id).rules.map((rule) => rangeName(rule.range))).toEqual(['C1:C10']);
  wb.undo();
  wb.addRule(id, { range: parseRange('E1:E5'), type: 'notEmpty', style: { bold: true } });
  wb.moveRows(id, 4, 3, 2); // row 5 from inside and rows 6-7 from below land inside E1:E5
  const pieces = wb.sheet(id).rules.filter((rule) => rule.range.c1 === 4);
  expect(overlapping(pieces)).toBe(false);
  expect(pieces.map((rule) => rangeName(rule.range))).toEqual(['E1:E7']);
});
