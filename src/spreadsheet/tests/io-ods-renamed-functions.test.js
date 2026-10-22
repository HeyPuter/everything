import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

const content = (bytes) => new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content);

function odsFile(formulas) {
  const zip = X.CFB.utils.cfb_new();
  const add = (path, text) => X.CFB.utils.cfb_add(zip, path, new TextEncoder().encode(text));
  add('mimetype', 'application/vnd.oasis.opendocument.spreadsheet');
  add('META-INF/manifest.xml', '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>');
  const rows = ['1', '2', '3', '4', '9'].map((v, r) => `<table:table-row><table:table-cell office:value-type="float" office:value="${v}"><text:p>${v}</text:p></table:table-cell>${r === 1 ? '<table:table-cell table:formula="of:=1+1" office:value-type="float" office:value="2"/>' : ''}</table:table-row>`).join('')
    + '<table:table-row><table:table-cell/></table:table-row>' + formulas.map((f) => `<table:table-row><table:table-cell table:formula="${f.replace(/"/g, '&quot;')}" office:value-type="float" office:value="0"/></table:table-row>`).join('');
  add('content.xml', '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="1.2">'
    + `<office:body><office:spreadsheet><table:table table:name="S">${rows}</table:table></office:spreadsheet></office:body></office:document-content>`);
  return new Uint8Array(X.CFB.write(zip, { type: 'array', fileType: 'zip' }));
}

// OpenFormula, and LibreOffice after it, names four of Excel's newer functions otherwise (as LibreOffice's own
// function table, formula/inc/core_resource.hrc, has them): FORMULA for FORMULATEXT, FDIST and FINV for F.DIST and
// F.INV, SKEWP for SKEW.P. They went into an .ods as COM.MICROSOFT.FORMULATEXT and the like, which LibreOffice
// does not know, and LibreOffice's own spellings read here as unknown names (#NAME?) or, for FDIST and FINV, as
// Excel's older right-tailed functions of the same name.
it.each([
  ['FORMULATEXT(B2)', 'FORMULA([.B2])', '=1+1'],
  ['F.DIST(2,3,4,TRUE)', 'FDIST(2;3;4;TRUE)', 0.7436128024718236],
  ['F.INV(0.5,3,4)', 'FINV(0.5;3;4)', 0.9405340763677539],
  ['SKEW.P(A1:A5)', 'SKEWP([.A1:.A5])', 1.039188922370417],
  ['FDIST(2,3,4)', 'LEGACY.FDIST(2;3;4)', 0.25638719752817635],
  ['FINV(0.5,3,4)', 'LEGACY.FINV(0.5;3;4)', 0.940534076367753],
])('writes %s as LibreOffice spells it, and reads it back', async (formula, written, value) => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  ['1', '2', '3', '4', '9'].forEach((v, r) => wb.setInput(id, r, 0, v));
  wb.setInput(id, 1, 1, '=1+1');
  wb.setInput(id, 6, 0, `=${formula}`);
  const bytes = new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer());
  expect(content(bytes)).toContain(`table:formula="of:=${written.replace(/"/g, '&quot;')}"`);
  for (const book of [await workbookFromFile(bytes, 'saved.ods'), await workbookFromFile(odsFile([`of:=${written}`]), 'lo.ods')]) {
    const sid = book.activeSheetId;
    expect(book.getCell(sid, 6, 0).f).toBe(formula);
    if (typeof value === 'number') expect(book.getValue(sid, 6, 0)).toBeCloseTo(value, 12);
    else expect(book.getValue(sid, 6, 0)).toBe(value);
  }
});
