import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { workbookFromFile } from '../src/core/io.js';

/** A one-sheet file whose column data table at B2 claims `ref` for its results (A1 its input, B1 its formula). */
function dataTableFile(ref) {
  const zip = X.CFB.read(new Uint8Array(X.write({ SheetNames: ['Data'], Sheets: { Data: { '!ref': 'A1' } } }, { type: 'array', bookType: 'xlsx' })), { type: 'array' });
  const sheet = X.CFB.find(zip, '/xl/worksheets/sheet1.xml');
  sheet.content = new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + '<row r="1"><c r="A1"><v>2</v></c><c r="B1"><f>A1*10</f><v>20</v></c></row>'
    + `<row r="2"><c r="A2"><v>3</v></c><c r="B2"><f t="dataTable" ref="${ref}" dt2D="0" dtr="0" r1="A1"/><v>30</v></c><c r="C2"><v>7</v></c></row>`
    + '<row r="3"><c r="A3"><v>4</v></c></row></sheetData></worksheet>');
  sheet.size = sheet.content.length;
  return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
}

// Opening a What-If data table visited every cell its results claim, to clear what other cells were stored
// there: a file whose table claims the whole sheet hung opening it, at seventeen billion cells. Only the
// cells the sheet holds are visited now when they are fewer, and a table past the cells any array may hold
// is #NUM! as such an array is, instead of running the tab out of memory working it out.
it('opens a data table that claims the whole sheet', async () => {
  const wb = await workbookFromFile(dataTableFile('B2:XFD1048576'), 'table.xlsx');
  const id = wb.activeSheetId;
  expect(wb.getCell(id, 1, 1)).toMatchObject({ f: 'TABLE(,A1)', array: { rows: 1048575, cols: 16383 } });
  expect(wb.getValue(id, 1, 1)).toEqual({ error: '#NUM!' });
  // A cell stored inside the results is the table's.
  expect(wb.getCell(id, 1, 2)?.v ?? null).toBeNull();
  expect(wb.getValue(id, 0, 1)).toBe(20);
});

it('still works out an ordinary data table and clears the cells under its results', async () => {
  const wb = await workbookFromFile(dataTableFile('B2:C3'), 'table.xlsx');
  const id = wb.activeSheetId;
  expect(wb.getCell(id, 1, 2)?.v ?? null).toBeNull();
  expect(wb.rangeValues(id, { r1: 1, c1: 1, r2: 2, c2: 1 })).toEqual([[30], [40]]);
});
