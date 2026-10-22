import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange, rangeName } from '../src/core/cell.js';
import { refill } from '../src/core/autofill-options.js';

// Dragging the fill handle from a cell with a conditional format (or pressing Ctrl+D under it) left the filled cells
// without the rule, though the fill gives them the cell's other formatting; Excel's fill carries conditional
// formatting too, unless Fill Without Formatting is chosen.
const bold = (wb, id, r, c) => !!wb.conditionalStyle(id, r, c, wb.getValue(id, r, c))?.bold;

it('takes a cell\'s conditional format down with the fill handle, its formula following each cell', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  for (let i = 0; i < 5; i++) wb.setInput(id, i, 1, String(i * 3));
  wb.setInput(id, 0, 0, 'x');
  wb.addRule(id, { range: parseRange('A1'), type: 'formula', value: '=$B1>5', style: { bold: true } });
  wb.fill(id, parseRange('A1'), parseRange('A1:A5'));
  expect([0, 1, 2, 3, 4].map((r) => bold(wb, id, r, 0))).toEqual([false, false, true, true, true]);
  wb.undo();
  expect(wb.sheet(id).rules.map((rule) => rangeName(rule.range))).toEqual(['A1']);
});

it('leaves a rule over the whole column as it is when filling inside it', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  for (let i = 0; i < 10; i++) wb.setInput(id, i, 2, String((i + 1) * 10));
  wb.addRule(id, { range: parseRange('C1:C10'), type: 'top', value: 3, style: { bold: true } });
  wb.fill(id, parseRange('C1'), parseRange('C1:C4'));
  expect(wb.sheet(id).rules.map((rule) => rangeName(rule.range))).toEqual(['C1:C10']);
});

it('replaces the filled cells\' own rule, and Fill Without Formatting leaves rules alone', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '1');
  wb.addRule(id, { range: parseRange('A1'), type: 'notEmpty', style: { bold: true } });
  wb.addRule(id, { range: parseRange('A3'), type: 'notEmpty', style: { italic: true } });
  wb.fill(id, parseRange('A1'), parseRange('A1:A3'));
  expect(wb.conditionalStyle(id, 2, 0, 1)).toEqual({ bold: true });
  wb.undo();
  refill(wb, id, parseRange('A1'), parseRange('A1:A3'), 'values');
  expect(wb.conditionalStyle(id, 1, 0, 1)).toBe(null);
  expect(wb.conditionalStyle(id, 2, 0, 1)).toEqual({ italic: true });
  wb.undo();
  refill(wb, id, parseRange('A1'), parseRange('A1:A3'), 'formats');
  expect(wb.conditionalStyle(id, 1, 0, 1)).toEqual({ bold: true });
});
