import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange, rangeName } from '../src/core/cell.js';

// The format painter run from C1 onto C2:C5, all under one Top 3 rule over C1:C10, cut C2:C5 out of the rule as a
// Top 3 of their own: 30, 40 and 50 turned bold beside 80, 90 and 100. Cells pasted over with the rule they already
// have stay with it.
function sheet() {
  const wb = new Workbook(), id = wb.activeSheetId;
  for (let i = 0; i < 12; i++) wb.setInput(id, i, 2, String((i + 1) * 10));
  wb.addRule(id, { range: parseRange('C1:C10'), type: 'top', value: 3, style: { bold: true } });
  return { wb, id };
}
const paint = (wb, id, from, to) => {
  const src = parseRange(from), dst = parseRange(to);
  const lines = (a, b) => Array.from({ length: b - a + 1 }, (_, k) => a + k);
  wb.pasteStyles(id, wb.copyRange(id, src), dst.r1, dst.c1, dst, { merges: [], conditionalFormats: wb.copyConditionalFormats(id, lines(src.r1, src.r2), lines(src.c1, src.c2)) });
};
const marked = (wb, id) => {
  const out = [];
  for (let r = 0; r < 12; r++) { const v = wb.getValue(id, r, 2); if (wb.conditionalStyle(id, r, 2, v)?.bold) out.push(v); }
  return out;
};

it('leaves cells painted with the rule they already have to that rule', () => {
  const { wb, id } = sheet();
  paint(wb, id, 'C1', 'C2:C5');
  expect(wb.sheet(id).rules.map((rule) => rangeName(rule.range))).toEqual(['C1:C10']);
  expect(marked(wb, id)).toEqual([80, 90, 100]);
});

it('still replaces another rule, and adds the painted rule where the cells had none', () => {
  const { wb, id } = sheet();
  wb.addRule(id, { range: parseRange('E1'), type: 'notEmpty', style: { italic: true } });
  paint(wb, id, 'E1', 'C2:C3');
  expect(wb.conditionalStyle(id, 1, 2, 20)).toEqual({ italic: true });
  expect(marked(wb, id)).toEqual([80, 90, 100]);
  paint(wb, id, 'C1', 'C9:C12');
  // C9:C10 keep the rule over C1:C10 (still less C2:C3); C11:C12 take a copy of it, ranking their own values.
  expect(marked(wb, id)).toEqual([80, 90, 100, 110, 120]);
});

it('keeps a formula rule whole when a block under it is painted with it', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.addRule(id, { range: parseRange('A1:A10'), type: 'formula', value: '=$B1>5', style: { bold: true } });
  paint(wb, id, 'A1:A2', 'A5:A8');
  expect(wb.sheet(id).rules.map((rule) => [rangeName(rule.range), rule.value])).toEqual([['A1:A10', '=$B1>5']]);
});
