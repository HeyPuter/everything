import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { styleToNumFmt } from '../src/core/format.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

// Optional digits (0.## shows 1.5, #.00 shows .50) were lost both ways in .ods files. The reader made a
// required 0 of every decimal LibreOffice marks optional (number:min-decimal-places below decimal-places)
// and of a missing integer digit (min-integer-digits="0"), so 1.5 opened as 1.50; the writer gave no
// min-decimal-places at all, which LibreOffice and the reader take as every decimal required.
const file = (elements) => new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
 xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
 <office:automatic-styles>${elements.map((element, i) => `
  <number:number-style style:name="N${i}">${element}</number:number-style>
  <style:style style:name="ce${i}" style:family="table-cell" style:data-style-name="N${i}"/>`).join('')}
 </office:automatic-styles>
 <office:body><office:spreadsheet><table:table table:name="Data">${elements.map((_, i) => `
  <table:table-row><table:table-cell table:style-name="ce${i}" office:value-type="float" office:value="0.5"><text:p>cached</text:p></table:table-cell></table:table-row>`).join('')}
 </table:table></office:spreadsheet></office:body>
</office:document>`);

it('reads LibreOffice\'s optional digits as #', async () => {
  const cases = [
    ['<number:number number:decimal-places="2" number:min-decimal-places="0" number:min-integer-digits="1"/>', '0.##', '0.5'],
    ['<number:number number:decimal-places="3" number:min-decimal-places="1" number:min-integer-digits="1" number:grouping="true"/>', '#,##0.0##', '0.5'],
    ['<number:number number:decimal-places="2" number:min-decimal-places="2" number:min-integer-digits="0"/>', '#.00', '.50'],
    // ODF 1.2 without the attribute: every decimal is required, as before.
    ['<number:number number:decimal-places="2" number:min-integer-digits="1"/>', '0.00', '0.50'],
  ];
  const wb = await workbookFromFile(file(cases.map((c) => c[0])), 'digits.fods');
  cases.forEach(([, code, shown], r) => {
    expect(styleToNumFmt(wb.getCell(wb.activeSheetId, r, 0).s)).toBe(code);
    expect(wb.getDisplay(wb.activeSheetId, r, 0)).toBe(shown);
  });
});

it.each([['0.##', '1.5', 'number:decimal-places="2" number:min-decimal-places="0"'], ['#,##0.0#', '1,234.5', 'number:decimal-places="2" number:min-decimal-places="1"'], ['#.00', '.50', 'number:min-integer-digits="0"']])(
  'saves %s with its optional digits', async (code, shown, attrs) => {
    const wb = new Workbook();
    const value = code === '#.00' ? 0.5 : code === '0.##' ? 1.5 : 1234.5;
    wb.setCells(wb.activeSheetId, [{ r: 0, c: 0, cell: { v: value, s: { fmt: 'custom', code } } }]);
    expect(wb.getDisplay(wb.activeSheetId, 0, 0)).toBe(shown);
    const bytes = new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer());
    expect(new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content)).toContain(attrs);
    const back = await workbookFromFile(bytes, 'digits.ods');
    expect(back.getDisplay(back.activeSheetId, 0, 0)).toBe(shown);
  });
