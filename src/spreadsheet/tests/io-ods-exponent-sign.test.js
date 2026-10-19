import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { styleToNumFmt } from '../src/core/format.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

const content = (bytes) => new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content);

// An exponent written E- shows its sign only when it is negative (1.50E03, 1.50E-03). The ODS
// writer knew only E+, found no exponent digits in E-00 and threw, so a workbook holding one
// such cell could not be saved as .ods at all.
it.each([['0.00E-00', 1500, '1.50E03'], ['0.00E-00', 0.0015, '1.50E-03'], ['##0.0E-0', 1500, '1.5E3']])(
  'saves %s as .ods and reopens it as it showed (%s)', async (code, value, shown) => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setCells(id, [{ r: 0, c: 0, cell: { v: value, s: { fmt: 'custom', code } } }]);
    expect(wb.getDisplay(id, 0, 0)).toBe(shown);
    const bytes = new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer());
    expect(content(bytes)).toMatch(/<number:scientific-number[^>]* number:forced-exponent-sign="false"/);
    const back = await workbookFromFile(bytes, 'exponent.ods');
    expect(back.getDisplay(back.activeSheetId, 0, 0)).toBe(shown);
  });

it('keeps E+ as a forced sign in an .ods', async () => {
  const wb = new Workbook();
  wb.setCells(wb.activeSheetId, [{ r: 0, c: 0, cell: { v: 0.0015, s: { fmt: 'custom', code: '0.0E+0' } } }]);
  const bytes = new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer());
  expect(content(bytes)).toMatch(/<number:scientific-number[^>]* number:forced-exponent-sign="true"/);
  const back = await workbookFromFile(bytes, 'exponent.ods');
  expect(back.getDisplay(back.activeSheetId, 0, 0)).toBe('1.5E-3');
});

const file = (attr) => new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
 xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
 <office:automatic-styles>
  <number:number-style style:name="N1"><number:scientific-number number:decimal-places="2" number:min-decimal-places="2" number:min-integer-digits="1" number:min-exponent-digits="2"${attr}/></number:number-style>
  <style:style style:name="ce1" style:family="table-cell" style:data-style-name="N1"/>
 </office:automatic-styles>
 <office:body><office:spreadsheet><table:table table:name="Data"><table:table-row><table:table-cell table:style-name="ce1" office:value-type="float" office:value="12345"><text:p>1.23E+04</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body>
</office:document>`);

// ODF 1.2 files, and LibreOffice before ODF 1.3, leave the attribute out; its default is a forced
// sign, which LibreOffice shows. The reader made a bare E of it, which is no format at all: #####.
it.each([['', '0.00E+00', '1.23E+04'], [' number:forced-exponent-sign="true"', '0.00E+00', '1.23E+04'], [' number:forced-exponent-sign="false"', '0.00E-00', '1.23E04']])(
  'reads a scientific format%s as LibreOffice shows it', async (attr, code, shown) => {
    const wb = await workbookFromFile(file(attr), 'scientific.fods');
    expect(styleToNumFmt(wb.getCell(wb.activeSheetId, 0, 0).s)).toBe(code);
    expect(wb.getDisplay(wb.activeSheetId, 0, 0)).toBe(shown);
  });
