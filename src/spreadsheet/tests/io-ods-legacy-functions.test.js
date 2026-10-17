import { expect, it } from 'vitest';
import * as XLSX from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

function ods(formulas) {
  const rows = [1, 2, 3].map((n) => `<table:table-row><table:table-cell office:value-type="float" office:value="${n}"/><table:table-cell office:value-type="float" office:value="${10 * n}"/></table:table-row>`).join('')
    + formulas.map((f) => `<table:table-row><table:table-cell table:formula="of:=${f.replace(/"/g, '&quot;')}" office:value-type="float" office:value="0"/></table:table-row>`).join('');
  const xml = new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" office:version="1.2">
 <office:body><office:spreadsheet><table:table table:name="Data">${rows}</table:table></office:spreadsheet></office:body>
</office:document-content>`);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[0]]), 'Data');
  const zip = XLSX.CFB.read(new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'ods' })), { type: 'array' });
  XLSX.CFB.utils.cfb_add(zip, 'content.xml', xml);
  return XLSX.CFB.write(zip, { type: 'array', fileType: 'zip' });
}

// OpenFormula spells NORMSDIST, CHIDIST, TDIST, FDIST, NORMSINV, CHIINV, FINV and CHITEST as LEGACY.*,
// as LibreOffice writes them, and those cells read as #NAME?; its intersection operator "!" read as #REF!.
const cases = [
  ['LEGACY.NORMSDIST(1)', 'NORMSDIST(1)'],
  ['LEGACY.CHIDIST(3;2)', 'CHIDIST(3,2)'],
  ['LEGACY.TDIST(1;2;1)', 'TDIST(1,2,1)'],
  ['LEGACY.FDIST(1;2;3)', 'FDIST(1,2,3)'],
  ['LEGACY.NORMSINV(0.9)', 'NORMSINV(0.9)'],
  ['LEGACY.CHIINV(0.5;2)', 'CHIINV(0.5,2)'],
  ['legacy.finv(0.5;2;3)', 'finv(0.5,2,3)'],
  ['SUM([.A1:.B3]![.B1:.C3])', 'SUM(A1:B3 B1:C3)'],
  ['IF(ISERROR(#REF!);1;2)', 'IF(ISERROR(#REF!),1,2)'],
  ['"LEGACY.TDIST(1)!"', '"LEGACY.TDIST(1)!"'],
];

it('reads LEGACY.* functions and the ! intersection as Excel spells them', async () => {
  const wb = await workbookFromFile(ods(cases.map(([f]) => f)), 'legacy.ods');
  const id = wb.activeSheetId;
  const ref = new Workbook();
  const rid = ref.activeSheetId;
  [1, 2, 3].forEach((n, r) => { ref.setInput(rid, r, 0, String(n)); ref.setInput(rid, r, 1, String(10 * n)); });
  cases.forEach(([, excel], i) => {
    ref.setInput(rid, 3 + i, 0, `=${excel}`);
    expect(wb.getCell(id, 3 + i, 0).f).toBe(excel);
    expect(wb.getValue(id, 3 + i, 0)).toEqual(ref.getValue(rid, 3 + i, 0));
  });
  expect(wb.getValue(id, 3, 0)).toBeCloseTo(0.841344746068543, 12);
  expect(wb.getValue(id, 10, 0)).toBe(60);
});

it('writes them back as OpenFormula spells them', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [1, 2, 3].forEach((n, r) => { wb.setInput(id, r, 0, String(n)); wb.setInput(id, r, 1, String(10 * n)); });
  wb.setInput(id, 3, 0, '=NORMSDIST(1)+CHIDIST(3,2)');
  wb.setInput(id, 4, 0, '=SUM(A1:B3 B1:C3)');
  wb.setInput(id, 5, 0, '=SUM((A1:A3,B1:B3) B2:B3)');
  wb.setInput(id, 6, 0, '=A1 + B1');
  const bytes = new Uint8Array(await (await workbookToOds(wb)).arrayBuffer());
  const content = new TextDecoder().decode(XLSX.CFB.find(XLSX.CFB.read(bytes, { type: 'array' }), 'content.xml').content);
  expect(content).toContain('of:=LEGACY.NORMSDIST(1)+LEGACY.CHIDIST(3;2)');
  expect(content).toContain('of:=SUM([.A1:.B3]![.B1:.C3])');
  expect(content).toContain('of:=SUM(([.A1:.A3]~[.B1:.B3])![.B2:.B3])');
  expect(content).toContain('of:=[.A1] + [.B1]');
  const back = await workbookFromFile(bytes, 'back.ods');
  expect([3, 4, 5, 6].map((r) => back.getValue(back.activeSheetId, r, 0))).toEqual([3, 4, 5, 6].map((r) => wb.getValue(id, r, 0)));
});
