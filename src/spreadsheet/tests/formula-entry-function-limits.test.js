import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

// The app took formulas Excel refuses: =ABS(ABS(…)) seventy deep, or SUM of 300 arguments. Excel takes
// functions nested 64 deep and 255 arguments to one function; it refuses an entry past either, and a
// saved file holding one makes it offer to repair the book. Such an entry now stays the text typed, as
// one past the length limit already does. Grouping parentheses and array constants are no functions,
// and a formula already in a file is read as it is.
const nested = (n) => `=${'ABS('.repeat(n)}-1${')'.repeat(n)}`;
const args = (n) => `=SUM(${Array(n).fill(1).join(',')})`;

function enter(text) {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, text);
  return { wb, id, cell: wb.getCell(id, 0, 0), value: wb.getValue(id, 0, 0) };
}

it('takes functions nested 64 deep and 255 arguments', () => {
  expect(enter(nested(64))).toMatchObject({ cell: { f: nested(64).slice(1) }, value: 1 });
  expect(enter(args(255))).toMatchObject({ cell: { f: args(255).slice(1) }, value: 255 });
});

it('keeps an entry past either limit as the text typed', () => {
  expect(enter(nested(65)).cell).toMatchObject({ f: null, v: nested(65) });
  expect(enter(args(256)).cell).toMatchObject({ f: null, v: args(256) });
  expect(enter(`=IF(1,${args(256).slice(1)},0)`).cell.f).toBeNull();
});

it('counts neither grouping parentheses, a union, nor an array constant', () => {
  expect(enter(`=${'('.repeat(100)}1${')'.repeat(100)}`).value).toBe(1);
  expect(enter(`=SUM({${Array(300).fill(1).join(',')}})`).value).toBe(300);
  expect(enter(`=SUM((${Array(300).fill('B1').join(',')}))`).cell.f).not.toBeNull();
  expect(enter(`=${'ABS(('.repeat(40)}-1${'))'.repeat(40)}`).cell.f).not.toBeNull();
});

it('still reads such a formula from a file', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: null, f: args(300).slice(1) } }]);
  const back = await workbookFromFile(await workbookToXlsx(wb), 'many.xlsx');
  expect(back.getCell(back.activeSheetId, 0, 0).f).toBe(args(300).slice(1));
  expect(back.getValue(back.activeSheetId, 0, 0)).toBe(300);
});
