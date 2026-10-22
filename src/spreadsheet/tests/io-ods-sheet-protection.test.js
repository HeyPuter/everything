import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

const content = (bytes) => new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content);

function odsFile(table, styles = '') {
  const zip = X.CFB.utils.cfb_new();
  const add = (path, text) => X.CFB.utils.cfb_add(zip, path, new TextEncoder().encode(text));
  add('mimetype', 'application/vnd.oasis.opendocument.spreadsheet');
  add('META-INF/manifest.xml', '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>');
  add('content.xml', '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" office:version="1.2">'
    + `<office:automatic-styles>${styles}</office:automatic-styles><office:body><office:spreadsheet>${table}</office:spreadsheet></office:body></office:document-content>`);
  return new Uint8Array(X.CFB.write(zip, { type: 'array', fileType: 'zip' }));
}

// A sheet protected in LibreOffice (Tools ▸ Protect Sheet) says so on its table, and the cells a form leaves
// open say style:cell-protect="none". Neither was read, so the form opened unprotected here and the next save
// wrote it that way; nor written, so a sheet protected here opened unprotected in LibreOffice, every cell open.
it('reads a protected LibreOffice sheet with its unlocked and formula-hidden cells', async () => {
  const wb = await workbookFromFile(odsFile(
    '<table:table table:name="Form" table:protected="true" table:protection-key="x"><table:table-row>'
      + '<table:table-cell office:value-type="string"><text:p>Name</text:p></table:table-cell>'
      + '<table:table-cell table:style-name="ce1"/>'
      + '<table:table-cell table:style-name="ce2" table:formula="of:=1+1" office:value-type="float" office:value="2"><text:p>2</text:p></table:table-cell>'
      + '<table:table-cell table:style-name="ce3" office:value-type="float" office:value="3"><text:p>3</text:p></table:table-cell>'
      + '</table:table-row></table:table>',
    '<style:style style:name="ce1" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties style:cell-protect="none"/></style:style>'
      + '<style:style style:name="ce2" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties style:cell-protect="hidden-and-protected"/></style:style>'
      + '<style:style style:name="ce3" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties style:cell-protect="formula-hidden"/></style:style>'), 'form.ods');
  const id = wb.activeSheetId;
  expect(wb.isProtected(id)).toBe(true);
  expect(wb.styleAt(id, 0, 0)?.locked).not.toBe(false);
  expect(wb.styleAt(id, 0, 1)).toMatchObject({ locked: false });
  expect(wb.styleAt(id, 0, 2)).toMatchObject({ formulaHidden: true });
  expect(wb.styleAt(id, 0, 2)?.locked).not.toBe(false);
  expect(wb.styleAt(id, 0, 3)).toMatchObject({ locked: false, formulaHidden: true });
  expect(wb.formulaHiddenAt(id, 0, 2)).toBe(true);
});

it('leaves an unprotected LibreOffice sheet unprotected', async () => {
  const wb = await workbookFromFile(odsFile('<table:table table:name="Open" table:protected="false"><table:table-row><table:table-cell office:value-type="string"><text:p>a</text:p></table:table-cell></table:table-row></table:table>'), 'open.ods');
  expect(wb.isProtected(wb.activeSheetId)).toBe(false);
});

it('writes a protected sheet, its unlocked input cells (blank ones too) and hidden formulas for LibreOffice', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Name');
  wb.setInput(id, 1, 0, '=1+1');
  wb.applyStyle(id, { r1: 0, c1: 1, r2: 0, c2: 1 }, { locked: false });
  wb.applyStyle(id, { r1: 1, c1: 0, r2: 1, c2: 0 }, { formulaHidden: true });
  wb.setSheetProtected(id, true);
  const bytes = new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer());
  const xml = content(bytes);
  expect(xml).toMatch(/<table:table [^>]*table:protected="true"/);
  expect(xml).toContain('style:cell-protect="none"');
  expect(xml).toContain('style:cell-protect="protected formula-hidden"');
  const back = await workbookFromFile(bytes, 'form.ods');
  const sid = back.activeSheetId;
  expect(back.isProtected(sid)).toBe(true);
  expect(back.styleAt(sid, 0, 1)).toMatchObject({ locked: false });
  expect(back.formulaHiddenAt(sid, 1, 0)).toBe(true);
  expect(back.styleAt(sid, 0, 0)?.locked).not.toBe(false);
});

it('writes no protection for an unprotected sheet of default cells', async () => {
  const wb = new Workbook();
  wb.setInput(wb.activeSheetId, 0, 0, 'x');
  const xml = content(new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer()));
  expect(xml).not.toContain('table:protected');
  expect(xml).not.toContain('cell-protect');
});
