import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// CELL's format, color, parentheses, prefix, protect and width info types answered #VALUE!, so a workbook testing
// LEFT(CELL("format",A1))="D" for a date, or reading a column's width, failed where Excel answers.
function book() {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '5');
  return { wb, id, cell: (formula) => { wb.setInput(id, 9, 6, `=${formula}`); return wb.getValue(id, 9, 6); } };
}

it.each([
  ['General', 'G'], ['0', 'F0'], ['#,##0', ',0'], ['0.00', 'F2'], ['#,##0.00', ',2'],
  ['$#,##0_);($#,##0)', 'C0'], ['$#,##0_);[Red]($#,##0)', 'C0-'], ['$#,##0.00_);($#,##0.00)', 'C2'],
  ['$#,##0.00_);[Red]($#,##0.00)', 'C2-'], ['0%', 'P0'], ['0.00%', 'P2'], ['0.00E+00', 'S2'], ['# ?/?', 'G'],
  ['m/d/yy', 'D4'], ['m/d/yy h:mm', 'D4'], ['mm/dd/yy', 'D4'], ['d-mmm-yy', 'D1'], ['dd-mmm-yy', 'D1'], ['d-mmm', 'D2'],
  ['mmm-yy', 'D3'], ['mm/dd', 'D5'], ['h:mm AM/PM', 'D7'], ['h:mm:ss AM/PM', 'D6'], ['h:mm', 'D9'], ['h:mm:ss', 'D8'],
  ['@', 'G'], ['"€"#,##0.00', 'C2'], ['0.0;[Red]-0.0', 'F1-'], ['(0)', 'F0()'],
])('CELL("format") of %s is %s, as Excel documents it', (code, expected) => {
  const { wb, id, cell } = book();
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { fmt: 'custom', code });
  expect(cell('CELL("format",A1)')).toBe(expected);
  expect(cell('CELL("color",A1)')).toBe(expected.includes('-') ? 1 : 0);
  expect(cell('CELL("parentheses",A1)')).toBe(expected.endsWith('()') ? 1 : 0);
});

it('reads the formats the app names, the label prefix of text, and whether a cell is locked', () => {
  const { wb, id, cell } = book();
  expect(cell('CELL("format",A1)')).toBe('G');
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { fmt: 'date' });
  expect(cell('LEFT(CELL("format",A1))="D"')).toBe(true);
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { fmt: 'percent', dec: 1 });
  expect(cell('CELL("format",A1)')).toBe('P1');
  wb.setInput(id, 0, 1, 'label');
  expect(cell('CELL("prefix",B1)')).toBe("'");
  for (const [align, prefix] of [['right', '"'], ['center', '^'], ['fill', '\\']]) {
    wb.applyStyle(id, { r1: 0, c1: 1, r2: 0, c2: 1 }, { align });
    expect(cell('CELL("prefix",B1)')).toBe(prefix);
  }
  expect(cell('CELL("prefix",A1)')).toBe('');
  expect(cell('CELL("protect",A1)')).toBe(1);
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { locked: false });
  expect(cell('CELL("protect",A1)')).toBe(0);
});

it('answers the column width in characters beside whether it is the default, as Excel 365 does', () => {
  const { wb, id } = book();
  wb.setInput(id, 4, 6, '=CELL("width",A1)');
  const width = wb.getValue(id, 4, 6);
  expect(Number.isInteger(width) && width > 0).toBe(true);
  expect(wb.getValue(id, 4, 7)).toBe(true);
  wb.setColWidth(id, 0, wb.colWidth(id, 0) * 2);
  expect(wb.getValue(id, 4, 6)).toBeGreaterThan(width * 2 - 2);
  expect(wb.getValue(id, 4, 7)).toBe(false);
  wb.setInput(id, 5, 6, '=CELL("width",A1)*1');
  expect(wb.getValue(id, 5, 6)).toBe(wb.getValue(id, 4, 6));
});
