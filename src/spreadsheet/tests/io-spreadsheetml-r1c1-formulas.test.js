import { expect, it } from 'vitest';
import { workbookFromFile } from '../src/core/io.js';

// Excel 2003 XML writes formulas in R1C1 notation. Whole columns and rows (C2 is column B, C[-1]
// the column to the left, R1:R2 the first two rows) were left untranslated, so =SUM(B:B) and
// =VLOOKUP(x,B:C,2,FALSE) from Excel opened as #NAME?; and text between quotes was translated as if it
// were references, so ="RC Cola" and a sheet named 'R1C1 notes' were changed.

const file = (formulas) => new TextEncoder().encode('<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>'
  + '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'
  + '<Worksheet ss:Name="Data"><Table><Row><Cell><Data ss:Type="Number">1</Data></Cell><Cell><Data ss:Type="Number">2</Data></Cell>'
  + '<Cell><Data ss:Type="Number">3</Data></Cell></Row><Row ss:Index="3"><Cell ss:Index="5"><Data ss:Type="Number">0</Data></Cell>'
  + formulas.map((f) => `<Cell ss:Formula="${f.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"><Data ss:Type="Number">0</Data></Cell>`).join('')
  + '</Row></Table></Worksheet><Worksheet ss:Name="R1C1 notes"><Table><Row><Cell><Data ss:Type="Number">7</Data></Cell></Row></Table></Worksheet></Workbook>');
const read = async (formulas) => {
  const wb = await workbookFromFile(file(formulas), 'formulas.xml');
  const id = wb.sheets[0].id;
  return formulas.map((_, i) => [wb.getCell(id, 2, 5 + i)?.f, wb.getValue(id, 2, 5 + i)]);
};

it('translates whole columns and rows', async () => {
  expect(await read(['=SUM(C2)', '=SUM(C[-4]:C[-3])', '=SUM(R1)', '=SUM(R[-2]:R[-1])', '=VLOOKUP(2,C2:C3,2,FALSE)'])).toEqual([
    ['SUM($B:$B)', 2], ['SUM(C:D)', 3], ['SUM($1:$1)', 6], ['SUM(1:2)', 6], ['VLOOKUP(2,$B:$C,2,FALSE)', 3],
  ]);
});

it('leaves strings and quoted sheet names as they are', async () => {
  expect(await read(['="RC Cola "&"R1C1"', "='R1C1 notes'!R1C1*2", '=IF(R1C1=1,"it\'s RC","no")'])).toEqual([
    ['"RC Cola "&"R1C1"', 'RC Cola R1C1'], ["'R1C1 notes'!$A$1*2", 14], ['IF($A$1=1,"it\'s RC","no")', "it's RC"],
  ]);
});

it('translates cells as before', async () => {
  expect(await read(['=R1C1+R1C2', '=SUM(R1C1:R1C3)', '=R[-2]C[-7]*10', '=ROUND(R1C3/R1C2,1)'])).toEqual([
    ['$A$1+$B$1', 3], ['SUM($A$1:$C$1)', 6], ['A1*10', 10], ['ROUND($C$1/$B$1,1)', 1.5],
  ]);
});
