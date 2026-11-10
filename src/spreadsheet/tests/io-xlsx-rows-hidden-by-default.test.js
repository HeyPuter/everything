import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook, MAX_ROWS } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { nativeSheetState } from '../src/core/xlsx-native-state.js';
import { editedXlsx } from './helpers/xlsx-excel-edit.js';

// A worksheet whose sheetFormatPr says zeroHeight="1" has its rows hidden by default: it lists only the rows it
// shows, and every row it does not list is hidden (ECMA-376 §18.3.1.81), which is how Excel can write a sheet with
// every row below its data hidden. Nothing read the attribute, so such a sheet opened with all its rows on show; and
// a sheet saved here with those rows hidden, saved again by Excel that way, now read as unhidden in Excel.
const hidden = (wb) => wb.sheets[0].hiddenRows;
const zeroHeight = (xml) => xml.replace(/<sheetFormatPr\b/, '<sheetFormatPr zeroHeight="1"');

it('hides the rows a sheet hiding its rows by default does not list', async () => {
  const book = X.utils.book_new();
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet([[1], [2], [3], [4]]), 'Data');
  // Excel's spelling: the shown rows listed, row 2 listed but hidden all the same, row 4 not listed.
  const blob = new Blob([X.write(book, { type: 'array', bookType: 'xlsx' })]);
  const file = await editedXlsx(blob, { '/xl/worksheets/sheet1.xml': (xml) => xml
    .replace(/<sheetData>/, '<sheetFormatPr defaultRowHeight="15" zeroHeight="1"/><sheetData>')
    .replace('<row r="2"', '<row r="2" hidden="1"').replace(/<row r="4"[\s\S]*?<\/row>/, '') });
  const wb = await workbookFromFile(new Blob([file]), 'excel.xlsx');
  expect(hidden(wb).has(0)).toBe(false);
  expect(hidden(wb).has(1)).toBe(true);
  expect(hidden(wb).has(2)).toBe(false);
  // Every row from the fourth to the sheet's last is hidden.
  expect(hidden(wb).size).toBe(1 + MAX_ROWS - 3);
  expect(hidden(wb).has(3) && hidden(wb).has(MAX_ROWS - 1)).toBe(true);
});

it('notes rows hidden by default as the same rows hidden one by one', () => {
  const listed = '<worksheet><sheetFormatPr zeroHeight="1"/><sheetData><row r="1"/><row r="2" hidden="1"/><row r="3"/></sheetData></worksheet>';
  const rows = '<worksheet><sheetFormatPr/><sheetData><row r="1"/><row r="2" hidden="1"/><row r="3"/>'
    + Array.from({ length: MAX_ROWS - 3 }, (_, i) => `<row r="${i + 4}" hidden="1"/>`).join('') + '</sheetData></worksheet>';
  expect(nativeSheetState(listed).hiddenRows).toEqual([[1, 1], [3, MAX_ROWS - 1]]);
  expect(nativeSheetState(listed).hiddenRows).toEqual(nativeSheetState(rows).hiddenRows);
});

it('keeps every row below the data hidden when Excel saves the sheet hiding rows by default', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const id = wb.activeSheetId;
  for (let r = 0; r < 3; r++) wb.setInput(id, r, 0, String(r + 1));
  wb.setHidden(id, 'row', Array.from({ length: MAX_ROWS - 3 }, (_, i) => i + 3), true);
  const saved = await workbookToXlsx(wb);
  // Excel writes the shown rows alone, and says the others are hidden by default.
  const respelled = (xml) => zeroHeight(xml.replace(/<row r="\d+"[^>]*? hidden="1"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g, ''));
  const back = await workbookFromFile(await editedXlsx(saved, { '/xl/worksheets/sheet1.xml': respelled }), 'mine.xlsx');
  expect(hidden(back).size).toBe(MAX_ROWS - 3);
  expect(hidden(back).has(2) || !hidden(back).has(3) || !hidden(back).has(MAX_ROWS - 1)).toBe(false);
  // Row 10 shown in Excel, which lists it: it stays on show.
  const shown = (xml) => respelled(xml).replace('</sheetData>', '<row r="10"/></sheetData>');
  const edited = await workbookFromFile(await editedXlsx(saved, { '/xl/worksheets/sheet1.xml': shown }), 'mine.xlsx');
  expect(hidden(edited).size).toBe(MAX_ROWS - 4);
  expect(hidden(edited).has(9)).toBe(false);
  expect(hidden(edited).has(3) && hidden(edited).has(10)).toBe(true);
}, 60000);
