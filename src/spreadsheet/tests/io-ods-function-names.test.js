import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

const content = (bytes) => new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content);

// The .ods writer took formulas in Excel's file spelling, where a function added since Excel 2007 is
// _xlfn.XLOOKUP (SORT and FILTER _xlfn._xlws.SORT) and a LET name _xlpm.x. LibreOffice reads none of
// that in an .ods: each such cell showed #NAME? as soon as it recalculated. OpenFormula names some of
// these functions itself (IFNA, XOR, DAYS); the others LibreOffice writes and reads as COM.MICROSOFT.*.
const cases = [
  ['=XLOOKUP(3,A1:A5,B1:B5)', 'of:=COM.MICROSOFT.XLOOKUP(3;[.A1:.A5];[.B1:.B5])', 'c'],
  ['=IFS(A1>2,"big",TRUE,"small")', 'of:=COM.MICROSOFT.IFS([.A1]&gt;2;&quot;big&quot;;TRUE;&quot;small&quot;)', 'small'],
  ['=COUNTA(FILTER(B1:B5,B1:B5="a"))', 'of:=COUNTA(COM.MICROSOFT.FILTER([.B1:.B5];[.B1:.B5]=&quot;a&quot;))', 2],
  ['=STDEV.S(A1:A5)', 'of:=COM.MICROSOFT.STDEV.S([.A1:.A5])', Math.sqrt(2.5)],
  ['=LET(x,2,x*3)', 'of:=COM.MICROSOFT.LET(x;2;x*3)', 6],
  ['=IFNA(NA(),"na")', 'of:=IFNA(NA();&quot;na&quot;)', 'na'],
  ['=XOR(TRUE,FALSE)+DAYS(45300,45293)', 'of:=XOR(TRUE;FALSE)+DAYS(45300;45293)', 8],
  ['=SUM(A1:A5)', 'of:=SUM([.A1:.A5])', 15],
];

it.each(cases)('writes %s with the function names LibreOffice reads', async (formula, written, value) => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (let r = 0; r < 5; r++) {
    wb.setInput(id, r, 0, String(r + 1));
    wb.setInput(id, r, 1, ['a', 'b', 'c', 'b', 'a'][r]);
  }
  wb.setInput(id, 0, 3, formula);
  expect(wb.getValue(id, 0, 3)).toEqual(value);
  const bytes = new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer());
  const xml = content(bytes);
  expect(xml).toContain(`table:formula="${written}"`);
  expect(xml).not.toMatch(/table:formula="[^"]*_xl(?:fn|ws|pm)\./);
  const back = await workbookFromFile(bytes, 'functions.ods');
  expect(back.getCell(back.activeSheetId, 0, 3).f).toBe(formula.slice(1));
  expect(back.getValue(back.activeSheetId, 0, 3)).toEqual(value);
});
