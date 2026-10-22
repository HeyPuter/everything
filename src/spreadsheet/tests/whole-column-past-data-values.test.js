import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// A whole column is read only to its sheet's used area, and an array computed from it, A:A="" or LEN(A:A)+1,
// stands for every row of the column. Paired with a whole column of another sheet holding more rows, it was
// padded with blanks past its own sheet's data, as though the expression gave nothing there: the rows past
// the data, where A:A="" is TRUE and LEN(A:A)+1 is 1, counted as FALSE and 0. SUMPRODUCT(--(A:A=""),Data!B:B)
// gave 20 where Excel gives 170, and XLOOKUP and FILTER missed every row past the data. The array now
// keeps what its expression gives for a blank cell, and is padded with that.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '1');
  wb.setInput(id, 2, 0, 'x'); // A2 is blank, and the sheet's data ends at row 3
  const data = wb.addSheet('Data').id;
  for (let r = 0; r < 6; r++) wb.setInput(data, r, 1, String(10 * (r + 1)));
  const at = (formula) => { wb.setInput(id, 0, 4, `=${formula}`); return wb.getValue(id, 0, 4); };
  return { at };
}

it('pairs an array of a whole column with a longer column of another sheet row for row', () => {
  const { at } = book();
  expect(at('SUMPRODUCT(--(A:A=""),Data!B:B)')).toBe(170); // A2 and rows 4 to 6
  expect(at('SUM((A:A<1)*Data!B:B)')).toBe(170); // a blank is 0, text is more than any number
  expect(at('SUMPRODUCT(LEN(A:A)+1,Data!B:B)')).toBe(250);
  expect(at('SUMPRODUCT(IF(A:A>1,1,5),Data!B:B)')).toBe(930);
  expect(at('SUMPRODUCT(IFS(A:A="x",2,TRUE,1),Data!B:B)')).toBe(240);
  expect(at('SUMPRODUCT(--ISBLANK(A:A),Data!B:B)')).toBe(170);
  expect(at('SUMPRODUCT(--ISNUMBER(A:A),Data!B:B)')).toBe(10);
});

it('finds and keeps the rows past the data', () => {
  const { at } = book();
  expect(at('XLOOKUP(1,(A:A="")*(Data!B:B>30),Data!B:B)')).toBe(40);
  expect(at('XMATCH(1,(A:A="")*(Data!B:B>30))')).toBe(4);
  expect(at('SUM(FILTER(Data!B:B,(A:A="")*(Data!B:B<>"")))')).toBe(170);
  // Within one sheet, and against a reference of its own size, nothing changes.
  expect(at('SUMPRODUCT(--(A1:A6=""),Data!B1:B6)')).toBe(170);
  expect(at('SUMPRODUCT(--(A:A=""),A:A)')).toBe(0);
});
