import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

// An Excel Binary Workbook (.xlsb) is offered by the Open dialog and read by the library, but its workbook part
// is binary records: the readers of a workbook's external links and slicers parsed that part as XML, and every
// .xlsb failed to open ("Unicode replacement character detected", then "missing root element"). They now leave
// a binary package to the library's own reading.
it('opens an .xlsb workbook with its values and formats, and saves it as .xlsx', async () => {
  const book = X.utils.book_new();
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet([
    ['Name', 'When', 'Amount'],
    ['Apples', { t: 'n', v: 45306, z: 'yyyy-mm-dd' }, { t: 'n', v: 1234.5, z: '#,##0.00' }],
    ['Pears é', { t: 'n', v: 45307 }, { t: 'b', v: true }],
  ]), 'Data');
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet([['second']]), 'More');
  const wb = await workbookFromFile(new Uint8Array(X.write(book, { type: 'array', bookType: 'xlsb' })), 'report.xlsb');
  expect(wb.sheets.map((sheet) => sheet.name)).toEqual(['Data', 'More']);
  const id = wb.sheetByName('Data').id;
  expect([wb.getDisplay(id, 1, 1), wb.getDisplay(id, 1, 2), wb.getValue(id, 2, 0), wb.getValue(id, 2, 2)]).toEqual(['2024-01-15', '1,234.50', 'Pears é', true]);
  const back = await workbookFromFile(await workbookToXlsx(wb), 'report.xlsx');
  expect(back.getDisplay(back.sheetByName('Data').id, 1, 2)).toBe('1,234.50');
});
