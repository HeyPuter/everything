import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

const content = (bytes) => new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content);

// Text between a number's digits (a social security number, a phone number, a ZIP+4) was written as
// the digits before it and then all the rest as one trailing text: 000-00-0000 left the file as 000"-",
// so LibreOffice, and this app reopening the .ods, showed 123456789- where the sheet showed 123-45-6789.
// ODF says such text as number:embedded-text inside the number, by the count of digits to its right.
it.each([
  ['000-00-0000', 123456789, '123-45-6789', [[6, '-'], [4, '-']]],
  ['(000) 000-0000', 5551234567, '(555) 123-4567', [[7, ') '], [4, '-']]],
  ['00000-0000', 123456789, '12345-6789', [[4, '-']]],
  ['0\\.000\\.000', 1234567, '1.234.567', [[6, '.'], [3, '.']]],
  ['00" / "00.00', 1234.5, '12 / 34.50', [[2, ' / ']]],
])('keeps the text between the digits of %s', async (code, value, shown, embedded) => {
  const wb = new Workbook();
  wb.setCells(wb.activeSheetId, [{ r: 0, c: 0, cell: { v: value, s: { fmt: 'custom', code } } }]);
  expect(wb.getDisplay(wb.activeSheetId, 0, 0)).toBe(shown);
  const bytes = new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer());
  const style = content(bytes).match(/<number:number-style\b[^>]*>[\s\S]*?<\/number:number-style>/)[0];
  expect([...style.matchAll(/<number:embedded-text number:position="(\d+)">([^<]*)<\/number:embedded-text>/g)].map((m) => [Number(m[1]), m[2]])).toEqual(embedded);
  const back = await workbookFromFile(bytes, 'numbers.ods');
  expect(back.getDisplay(back.activeSheetId, 0, 0)).toBe(shown);
});

// LibreOffice lists a number's embedded texts left to right (the largest position first), but a reader
// keys them by position, and another writer may list them the other way round. The position counts the
// integer digits to the right of the text, not characters, and not the decimals: inserted at a character
// offset from the end, 000-00-0000 read as 00000""-"-"0000 and 00-00.00 as 0000."-"00.
it.each([
  ['descending', [[4, '-'], [6, '-']].reverse(), 9, 0, 123456789, '123-45-6789'],
  ['ascending', [[4, '-'], [6, '-']], 9, 0, 123456789, '123-45-6789'],
  ['with decimals', [[2, '-']], 4, 2, 1234.5, '12-34.50'],
  ['past the digits', [[5, 'No. ']], 2, 0, 42, 'No. 42'],
])('reads embedded text by its digit position (%s)', async (_, texts, digits, decimals, value, shown) => {
  const embedded = texts.map(([position, text]) => `<number:embedded-text number:position="${position}">${text}</number:embedded-text>`).join('');
  const zip = X.CFB.utils.cfb_new();
  const add = (path, text) => X.CFB.utils.cfb_add(zip, path, new TextEncoder().encode(text));
  add('mimetype', 'application/vnd.oasis.opendocument.spreadsheet');
  add('META-INF/manifest.xml', '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>');
  add('content.xml', '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" office:version="1.2">'
    + `<office:automatic-styles><number:number-style style:name="N1"><number:number number:decimal-places="${decimals}" number:min-decimal-places="${decimals}" number:min-integer-digits="${digits}">${embedded}</number:number></number:number-style>`
    + '<style:style style:name="ce1" style:family="table-cell" style:parent-style-name="Default" style:data-style-name="N1"/></office:automatic-styles>'
    + `<office:body><office:spreadsheet><table:table table:name="S"><table:table-row><table:table-cell table:style-name="ce1" office:value-type="float" office:value="${value}"><text:p>x</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`);
  const wb = await workbookFromFile(new Uint8Array(X.CFB.write(zip, { type: 'array', fileType: 'zip' })), 'lo.ods');
  expect(wb.getDisplay(wb.activeSheetId, 0, 0)).toBe(shown);
});
