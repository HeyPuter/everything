import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// A formula giving "" was taken for an empty cell by the criteria "=" and "<>": COUNTIF(A1:A5,"<>")
// left it out of the cells counted as filled, and "=" counted it as empty. In Excel an empty
// criterion matches blank cells and empty text alike, but "=" and "<>" written out ask whether a
// cell is empty: "<>" counts a formula giving "" (as COUNTA does) and "=" counts only truly blank
// cells.
function book() {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '1');
  wb.setInput(id, 1, 0, '=""');
  wb.setInput(id, 2, 0, 'x');
  // A4 and A5 are blank.
  return { wb, id, calc: (f) => { wb.setInput(id, 0, 3, f); return wb.getValue(id, 0, 3); } };
}

it.each([
  ['COUNTIF(A1:A5,"")', 3],
  ['COUNTIF(A1:A5,"=")', 2],
  ['COUNTIF(A1:A5,"<>")', 3],
  ['COUNTIFS(A1:A5,"<>",A1:A5,"<>x")', 2],
  ['COUNTA(A1:A5)', 3],
  ['COUNTBLANK(A1:A5)', 3],
  ['SUMPRODUCT(--(A1:A5=""))', 3],
])('%s is %s', (formula, value) => {
  expect(book().calc(`=${formula}`)).toBe(value);
});
