import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

const styles = (zip) => new TextDecoder().decode(X.CFB.find(zip, '/xl/styles.xml').content);

/** An .xlsx whose A1 holds `value` in built-in number format `id`, named by its id alone, as Excel writes it. */
function withBuiltinId(id, value) {
  const book = X.utils.book_new();
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet([['x']]), 'Data');
  const zip = X.CFB.read(new Uint8Array(X.write(book, { type: 'array', bookType: 'xlsx' })), { type: 'array' });
  const sheet = X.CFB.find(zip, '/xl/worksheets/sheet1.xml');
  sheet.content = new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" s="1"><v>${value}</v></c></row></sheetData></worksheet>`);
  sheet.size = sheet.content.length;
  const entry = X.CFB.find(zip, '/xl/styles.xml');
  const xml = styles(zip).replace(/<numFmts[\s\S]*?<\/numFmts>/, '').replace(/<cellXfs[\s\S]*?<\/cellXfs>/,
    `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="${id}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>`);
  entry.content = new TextEncoder().encode(xml); entry.size = entry.content.length;
  return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
}

// Excel's built-in format 47 shows minutes and seconds to a tenth (30:00.0 for half an hour), the
// mm:ss.0 of its Custom list. The format table the reader starts from spells it as the specification
// lists it, mmss.0, without the colon, so a lap or a call time from Excel showed as 3000.0 here.
it('shows built-in format 47 as Excel does, and writes it back as that format', async () => {
  const wb = await workbookFromFile(withBuiltinId(47, 30 / 1440 + 1.5 / 86400), 'laps.xlsx');
  const id = wb.activeSheetId;
  expect(wb.getDisplay(id, 0, 0)).toBe('30:01.5');
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  expect(styles(zip)).toMatch(/<xf numFmtId="47"/);
  const back = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'saved.xlsx');
  expect(back.getDisplay(back.activeSheetId, 0, 0)).toBe('30:01.5');
});

it('keeps a format typed as mm:ss.0 showing minutes and seconds in Excel', async () => {
  const wb = new Workbook();
  wb.setCells(wb.activeSheetId, [{ r: 0, c: 0, cell: { v: 75.3 / 86400, s: { fmt: 'custom', code: 'mm:ss.0' } } }]);
  expect(wb.getDisplay(wb.activeSheetId, 0, 0)).toBe('01:15.3');
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  // Either Excel's own id or a spelled-out code shows mm:ss.0 there, never the colonless spec spelling.
  expect(styles(zip)).not.toContain('formatCode="mmss.0"');
  const back = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'saved.xlsx');
  expect(back.getDisplay(back.activeSheetId, 0, 0)).toBe('01:15.3');
});
