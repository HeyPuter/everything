import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

/** An .xlsx whose row 2 is written as `row`, between a 1 in A1 and a SUBTOTAL of A1:A2 in A3. */
function file(row) {
  const book = X.utils.book_new();
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet([['x']]), 'Data');
  const zip = X.CFB.read(new Uint8Array(X.write(book, { type: 'array', bookType: 'xlsx' })), { type: 'array' });
  const sheet = X.CFB.find(zip, '/xl/worksheets/sheet1.xml');
  sheet.content = new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + `<row r="1"><c r="A1"><v>1</v></c></row>${row}<row r="3"><c r="A3"><f>SUBTOTAL(109,A1:A2)</f></c></row></sheetData></worksheet>`);
  sheet.size = sheet.content.length;
  return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
}

// A row a file gives a height of nothing (ht="0", the row dragged shut in some programs, or written so by a
// generator) shows in Excel as no row at all, as a hidden one does. Its height of 0 read as no height, so it
// opened at the default height, its contents on show and counted by SUBTOTAL(109, …) as a visible row.
it('opens a row of zero height as a hidden row, and saves it so', async () => {
  for (const row of ['<row r="2" ht="0" customHeight="1"><c r="A2"><v>2</v></c></row>', '<row r="2" ht="0"><c r="A2"><v>2</v></c></row>']) {
    let wb = await workbookFromFile(file(row), 'zero.xlsx');
    for (let round = 0; round < 2; round++) {
      const id = wb.activeSheetId;
      expect(wb.isRowHidden(id, 1)).toBe(true);
      expect(wb.getValue(id, 2, 0)).toBe(1);
      wb = await workbookFromFile(await workbookToXlsx(wb), 'saved.xlsx');
    }
  }
});

it('leaves rows with a height as they were', async () => {
  const wb = await workbookFromFile(file('<row r="2" ht="15" customHeight="1"><c r="A2"><v>2</v></c></row>'), 'rows.xlsx');
  expect(wb.isRowHidden(wb.activeSheetId, 1)).toBe(false);
  expect(wb.getValue(wb.activeSheetId, 2, 0)).toBe(3);
});
