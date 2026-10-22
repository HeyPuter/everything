import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

const content = (bytes) => new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content);

function odsFile(formula) {
  const zip = X.CFB.utils.cfb_new();
  const add = (path, text) => X.CFB.utils.cfb_add(zip, path, new TextEncoder().encode(text));
  add('mimetype', 'application/vnd.oasis.opendocument.spreadsheet');
  add('META-INF/manifest.xml', '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>');
  add('content.xml', '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="1.2">'
    + `<office:body><office:spreadsheet><table:table table:name="S"><table:table-row><table:table-cell table:formula="${formula}" office:value-type="float" office:value="0"/></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`);
  return new Uint8Array(X.CFB.write(zip, { type: 'array', fileType: 'zip' }));
}

// Excel's CEILING, FLOOR and ISO.CEILING are not OpenFormula's: LibreOffice reads Excel's as COM.MICROSOFT.CEILING
// and the like (its function table, formula/inc/core_resource.hrc), and its own CEILING and FLOOR take an optional
// significance and a mode, as Excel's CEILING.MATH and FLOOR.MATH do, which is what LibreOffice saves them as in an
// .xlsx. Written bare, Excel's two-argument functions became LibreOffice's; read bare, LibreOffice's became Excel's,
// and CEILING(2.5), with no significance, was #N/A here instead of 3.
it.each([
  ['CEILING(-2.5,2)', 'COM.MICROSOFT.CEILING(-2.5;2)', -2],
  ['FLOOR(2.5,2)', 'COM.MICROSOFT.FLOOR(2.5;2)', 2],
  ['ISO.CEILING(-2.5,2)', 'COM.MICROSOFT.ISO.CEILING(-2.5;2)', -2],
  ['CEILING.MATH(-2.5,2,1)', 'COM.MICROSOFT.CEILING.MATH(-2.5;2;1)', -4],
])('writes Excel\'s %s as LibreOffice reads it, and reads it back', async (formula, written, value) => {
  const wb = new Workbook();
  wb.setInput(wb.activeSheetId, 0, 0, `=${formula}`);
  expect(wb.getValue(wb.activeSheetId, 0, 0)).toBe(value);
  const bytes = new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer());
  expect(content(bytes)).toContain(`table:formula="of:=${written}"`);
  const back = await workbookFromFile(bytes, 'round.ods');
  expect(back.getCell(back.activeSheetId, 0, 0).f).toBe(formula);
  expect(back.getValue(back.activeSheetId, 0, 0)).toBe(value);
});

it.each([
  ['of:=CEILING(2.5)', 'CEILING.MATH(2.5)', 3],
  ['of:=CEILING(-2.5;2;1)', 'CEILING.MATH(-2.5,2,1)', -4],
  ['of:=FLOOR(-2.5)', 'FLOOR.MATH(-2.5)', -3],
  ['of:=COM.MICROSOFT.CEILING(2.5;2)', 'CEILING(2.5,2)', 4],
])('reads LibreOffice\'s %s as %s', async (written, formula, value) => {
  const wb = await workbookFromFile(odsFile(written), 'lo.ods');
  expect(wb.getCell(wb.activeSheetId, 0, 0).f).toBe(formula);
  expect(wb.getValue(wb.activeSheetId, 0, 0)).toBe(value);
});
