import { expect, it } from 'vitest';
import * as XLSX from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds, workbookToXlsx } from '../src/core/io.js';

it.each([
  ['0.00" & units"', '7.50 & units'],
  ['"< "0.00', '< 7.50'],
  ['0.00" &amp;"', '7.50 &amp;'],
  ['0.00" _x0041_"', '7.50 _x0041_'],
])('preserves literal text after saving and reopening ODS: %s', async (code, expected) => {
  const wb = new Workbook();
  wb.setCells(wb.activeSheetId, [{ r: 0, c: 0, cell: { v: 7.5, s: { fmt: 'custom', code } } }]);
  expect(wb.getDisplay(wb.activeSheetId, 0, 0)).toBe(expected);
  const back = await workbookFromFile(await workbookToOds(wb), 'literal.ods');
  expect(back.getValue(back.activeSheetId, 0, 0)).toBe(7.5);
  expect(back.getDisplay(back.activeSheetId, 0, 0)).toBe(expected);
});

function file(mode, kind, encoded) {
  const ns = `xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
    xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
    xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0"
    xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"`;
  const number = '<number:number number:min-integer-digits="1" number:decimal-places="1"/>';
  const contents = kind === 'currency'
    ? `<number:currency-symbol>${encoded}</number:currency-symbol>${number}`
    : kind === 'embedded'
      ? `<number:number number:min-integer-digits="1" number:decimal-places="1"><number:embedded-text number:position="0">${encoded}</number:embedded-text></number:number>`
      : `${number}<number:text>${encoded}</number:text>`;
  const type = kind === 'currency' ? 'currency' : kind === 'percentage' ? 'percentage' : 'number';
  const definitions = `<number:${type}-style style:name="N1">${contents}</number:${type}-style><style:style style:name="s1" style:family="table-cell" style:data-style-name="N1"/>`;
  const root = mode === 'fods' ? 'document' : 'document-content';
  const content = new TextEncoder().encode(`<?xml version="1.0"?><office:${root} ${ns} office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
    ${mode === 'fods' ? `<office:styles>${definitions}</office:styles>` : ''}
    <office:body><office:spreadsheet><table:table table:name="Data"><table:table-row><table:table-cell office:value-type="float" office:value="7.5" table:style-name="s1"/></table:table-row></table:table></office:spreadsheet></office:body></office:${root}>`);
  if (mode === 'fods') return content;
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[0]]), 'Data');
  const zip = XLSX.CFB.read(new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'ods' })), { type: 'array' });
  XLSX.CFB.utils.cfb_add(zip, 'content.xml', content);
  XLSX.CFB.utils.cfb_add(zip, 'styles.xml', new TextEncoder().encode(`<?xml version="1.0"?><office:document-styles ${ns} office:version="1.2"><office:styles>${definitions}</office:styles></office:document-styles>`));
  return XLSX.CFB.write(zip, { type: 'array', fileType: 'zip' });
}

it.each(['fods', 'ods'].flatMap((mode) => ['text', 'currency', 'embedded'].flatMap((kind) => [
  ['&amp;&lt;&gt;&apos;&quot;', '&<>\'"'],
  ['&#38;&#x26;', '&&'],
  ['&#128512;&#x1F600;', '😀😀'],
  ['&amp;amp;', '&amp;'],
  ['_x0041_', '_x0041_'],
  ['<![CDATA[&amp; < >]]>', '&amp; < >'],
].map(([encoded, literal]) => ({ mode, kind, encoded, literal })))))(
  'decodes XML text once in ODS number formats: %j', async ({ mode, kind, encoded, literal }) => {
    const wb = await workbookFromFile(file(mode, kind, encoded), `entities.${mode}`);
    // Embedded text at position 0 stands just before the decimal separator, as LibreOffice reads it.
    const expected = kind === 'currency' ? `${literal}7.5` : kind === 'embedded' ? `7${literal}.5` : `7.5${literal}`;
    for (const back of [wb, await workbookFromFile(await workbookToXlsx(wb), 'saved.xlsx')]) {
      expect(back.getValue(back.activeSheetId, 0, 0)).toBe(7.5);
      expect(back.getDisplay(back.activeSheetId, 0, 0)).toBe(expected);
    }
  },
);


it.each(['fods', 'ods'].flatMap((mode) => ['%', '&#37;', '&#x25;'].map((encoded) => ({ mode, encoded })) ))(
  'recognizes encoded percent tokens as percentage formatting: %j', async ({ mode, encoded }) => {
    const wb = await workbookFromFile(file(mode, 'percentage', encoded), `percent.${mode}`);
    expect(wb.getValue(wb.activeSheetId, 0, 0)).toBe(7.5);
    expect(wb.getDisplay(wb.activeSheetId, 0, 0)).toBe('750.0%');
  },
);
