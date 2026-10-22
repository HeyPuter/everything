import { expect, it } from 'vitest';
import * as XLSX from '../src/vendor/xlsx.mjs';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { ymdToSerial } from '../src/core/format.js';

// A 1904-system file's date cells move to this app's 1900 serials, but an AutoFilter's custom bounds on
// a date column (Excel stores "after 2024-01-01" as that day's serial) did not, so the filter compared
// 1900 dates with a 1904 bound four years early: the rows the file hid came back as soon as the filter
// was applied again (Reapply, or an edit in the list). The bounds now move with a date column's cells.
const S1904 = (y, m, d) => ymdToSerial(y, m, d) - 1462;

function file(filter) {
  const book = XLSX.utils.book_new();
  book.Workbook = { WBProps: { date1904: true } };
  XLSX.utils.book_append_sheet(book, {
    '!ref': 'A1:B4', A1: { t: 's', v: 'When' }, B1: { t: 's', v: 'Count' },
    A2: { t: 'n', v: S1904(2023, 6, 1), z: 'yyyy-mm-dd' }, A3: { t: 'n', v: S1904(2024, 6, 1), z: 'yyyy-mm-dd' }, A4: { t: 'n', v: S1904(2025, 6, 1), z: 'yyyy-mm-dd' },
    B2: { t: 'n', v: 40000 }, B3: { t: 'n', v: 45000 }, B4: { t: 'n', v: 50000 },
  }, 'Data');
  const zip = XLSX.CFB.read(new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' })), { type: 'array' });
  const text = (path) => new TextDecoder().decode(XLSX.CFB.find(zip, path).content);
  XLSX.CFB.utils.cfb_add(zip, '/xl/worksheets/sheet1.xml', new TextEncoder().encode(text('/xl/worksheets/sheet1.xml')
    .replace('<row r="2"', '<row r="2" hidden="1"').replace('</sheetData>', `</sheetData><autoFilter ref="A1:B4">${filter}</autoFilter>`)));
  return XLSX.CFB.write(zip, { type: 'array', fileType: 'zip' });
}
const custom = (col, items, and = false) => `<filterColumn colId="${col}"><customFilters${and ? ' and="1"' : ''}>${items.map(([op, val]) => `<customFilter operator="${op}" val="${val}"/>`).join('')}</customFilters></filterColumn>`;
const shown = (wb) => [1, 2, 3].map((r) => !wb.isRowHidden(wb.activeSheetId, r));

it('keeps a date filter\'s bound on the day it names when the filter is applied again', async () => {
  const wb = await workbookFromFile(file(custom(0, [['greaterThan', S1904(2024, 1, 1)]])), 'mac.xlsx');
  wb.reapplyFilter(wb.activeSheetId);
  expect(shown(wb)).toEqual([false, true, true]);
  // Saved by this app the file is on the 1900 system, so nothing moves twice.
  const back = await workbookFromFile(await workbookToXlsx(wb), 'saved.xlsx');
  back.reapplyFilter(back.activeSheetId);
  expect(shown(back)).toEqual([false, true, true]);
});

it('moves both bounds of a between filter, and leaves a number column\'s bounds alone', async () => {
  const between = await workbookFromFile(file(custom(0, [['greaterThanOrEqual', S1904(2024, 1, 1)], ['lessThanOrEqual', S1904(2024, 12, 31)]], true)), 'mac.xlsx');
  between.reapplyFilter(between.activeSheetId);
  expect(shown(between)).toEqual([false, true, false]);
  const numbers = await workbookFromFile(file(custom(1, [['greaterThan', 42000]])), 'mac.xlsx');
  numbers.reapplyFilter(numbers.activeSheetId);
  expect(shown(numbers)).toEqual([false, true, true]);
});
