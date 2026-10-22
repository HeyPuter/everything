import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { workbookFromFile } from '../src/core/io.js';
import { xlsxScalarFormula } from '../src/core/xlsx-scalar-formula.js';

// An ordinary cell of a file whose formula reads a range as one value gets the @ it stands for, and the
// formula was then printed again from its parsed form: every defined name came out in capitals
// (IFERROR(@INDEX(PRICELIST,MATCH(A2,CODES,0)),"")), the line breaks and spaces of a long formula
// were dropped, 1E+300 became 1e+300, and a name of a linked workbook, [1]!Rate, became '[1]'!RATE.
// Only the @ is added now; the rest of the text stays as the file wrote it.
it('adds the @ without rewriting the rest of the formula', () => {
  expect(xlsxScalarFormula('IFERROR(INDEX(PriceList,MATCH(A2,Codes,0)),"")')).toBe('IFERROR(@INDEX(PriceList,MATCH(A2,Codes,0)),"")');
  expect(xlsxScalarFormula('IF(A2>0,\n  INDEX(Data!B:B, ROW()),\n  "")')).toBe('IF(A2>0,\n  @INDEX(Data!B:B, ROW()),\n  "")');
  expect(xlsxScalarFormula('1E+300*A1:A3 + TaxRate')).toBe('1E+300*@A1:A3 + TaxRate');
  expect(xlsxScalarFormula('[1]!Rate*A1:A3')).toBe('[1]!Rate*@A1:A3');
  expect(xlsxScalarFormula("'Q1 Data'!Rate+Sheet1:Sheet3!A1:A2")).toBe("'Q1 Data'!Rate+@Sheet1:Sheet3!A1:A2");
  // Each kind of operand still takes its @ where it begins.
  expect(xlsxScalarFormula('-A1:A3^2+(B1:B3,C1)+{1,2}')).toBe('-@A1:A3^2+@(B1:B3,C1)+@{1,2}');
  expect(xlsxScalarFormula('A1:INDEX(B1:B3,2)+((C1:C3))')).toBe('@A1:INDEX(B1:B3,2)+((@C1:C3))');
  expect(xlsxScalarFormula('A1:A3 B1:B3+LEN(D1:D3)')).toBe('@A1:A3 B1:B3+LEN(@D1:D3)');
  expect(xlsxScalarFormula('A1,B1')).toBe('@(A1,B1)');
});

it('opens a legacy file with its names spelled as written', async () => {
  const sheet = { '!ref': 'A1:C3', A1: { t: 's', v: 'x' }, B1: { t: 'n', v: 5 }, A2: { t: 's', v: 'x' },
    C2: { t: 'n', v: 0, f: 'IFERROR(INDEX(PriceList,MATCH(A2,Codes,0)),"")' } };
  const book = X.utils.book_new();
  X.utils.book_append_sheet(book, sheet, 'Data');
  book.Workbook = { Names: [{ Name: 'PriceList', Ref: 'Data!$B$1:$B$3' }, { Name: 'Codes', Ref: 'Data!$A$1:$A$3' }] };
  const wb = await workbookFromFile(X.write(book, { type: 'array', bookType: 'xlsx' }), 'legacy.xlsx');
  const id = wb.activeSheetId;
  expect(wb.getCell(id, 1, 2).f).toBe('IFERROR(@INDEX(PriceList,MATCH(A2,Codes,0)),"")');
  expect(wb.getValue(id, 1, 2)).toBe(5);
});
