import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds, workbookToXlsx } from '../src/core/io.js';

const BROKEN = ['=1+', '=1 2', '="abc', '=A1:', '=)', '=1/', '={1,2', '="a"&', '=$A$1:$B', '=Sheet1!', '=1..2'];
const ERROR = { error: '#ERROR!' };

function typed() {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const id = wb.activeSheetId;
  BROKEN.forEach((text, r) => wb.setInput(id, r, 0, text));
  wb.setInput(id, 0, 1, '=1+1');
  wb.setInput(id, 1, 1, '=A1 B1'); // Excel's intersection operator: not read here, read there
  wb.setInput(id, 2, 1, '=@A1'); // parses, and this app answers #ERROR! for it
  wb.setInput(id, 3, 1, '=IF(1>2,1');
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { fmt: 'currency', dec: 2, cur: 'USD' });
  return wb;
}
async function partsOf(blob, path) {
  const zip = X.CFB.read(new Uint8Array(await blob.arrayBuffer()), { type: 'array' });
  return new TextDecoder().decode(X.CFB.find(zip, path).content);
}

// A formula the app could not parse (=1+ shows #ERROR!) was written into the file as a
// formula with a cached #VALUE!, and Excel validates every formula on opening: one typo
// left in a cell made every save a file Excel opens only after a repair that deletes it.
it('writes a formula no program can read as its text, and Excel-readable ones as formulas', async () => {
  const wb = typed();
  const blob = await workbookToXlsx(wb);
  const raw = X.read(new Uint8Array(await blob.arrayBuffer()), { type: 'array', cellNF: true });
  const sheet = raw.Sheets.Data;
  BROKEN.forEach((text, r) => {
    const cell = sheet[X.utils.encode_cell({ r, c: 0 })];
    expect(cell).toMatchObject({ t: 's', v: text });
    expect(cell.f).toBeUndefined();
  });
  expect(sheet.B1).toMatchObject({ t: 'n', v: 2, f: '1+1' });
  expect(sheet.B2).toMatchObject({ t: 'e', f: 'A1 B1' });
  expect(sheet.B3).toMatchObject({ t: 'e', f: 'SINGLE(A1)' });
  expect(sheet.B4).toMatchObject({ t: 'b', v: false, f: 'IF(1>2,1)' });
  const xml = await partsOf(blob, '/xl/worksheets/sheet1.xml');
  expect(xml).not.toMatch(/<f>1\+<\/f>|<f>1 2<\/f>|<f>"abc<\/f>|<f>\)<\/f>/);
  expect(xml).toContain('<f>1+1</f>');
  // The cell keeps its own number format rather than being forced to Text.
  expect(sheet.A1.z).toBe('"$"#,##0.00');
});

it('restores the formulas from the sidecar on opening, with the cells\' own formats', async () => {
  const wb = typed();
  const back = await workbookFromFile(await workbookToXlsx(wb), 'typed.xlsx');
  const id = back.activeSheetId;
  BROKEN.forEach((text, r) => {
    expect(back.getCell(id, r, 0)).toMatchObject({ v: null, f: text.slice(1) });
    expect(back.getValue(id, r, 0)).toEqual(ERROR);
    expect(back.getDisplay(id, r, 0)).toBe('#ERROR!');
  });
  expect(back.getCell(id, 0, 0).s).toEqual({ fmt: 'currency', dec: 2, cur: 'USD' });
  expect(back.getCell(id, 1, 1)).toMatchObject({ f: 'A1 B1' });
  expect(back.getCell(id, 2, 1)).toMatchObject({ f: '@A1' });
  // A second save writes the same file again.
  const again = X.read(new Uint8Array(await (await workbookToXlsx(back)).arrayBuffer()), { type: 'array' });
  expect(again.Sheets.Data.A1).toMatchObject({ t: 's', v: '=1+' });
  expect(again.Sheets.Data.A1.f).toBeUndefined();
});

it('shows the text to a program without the sidecar, and leaves a cell another program changed alone', async () => {
  const wb = typed();
  const blob = await workbookToXlsx(wb);
  const zip = X.CFB.read(new Uint8Array(await blob.arrayBuffer()), { type: 'array' });
  // The sidecar sheet removed: the cells are plain text, as Excel shows them.
  const stripped = X.CFB.read(new Uint8Array(await blob.arrayBuffer()), { type: 'array' });
  const meta = X.read(X.CFB.write(stripped, { type: 'array', fileType: 'zip' }), { type: 'array' }).SheetNames.findIndex((n) => /^_puter_meta/.test(n));
  const metaSheet = X.CFB.find(stripped, `/xl/worksheets/sheet${meta + 1}.xml`);
  metaSheet.content = new TextEncoder().encode(new TextDecoder().decode(metaSheet.content).replace(/<sheetData>[\s\S]*<\/sheetData>/, '<sheetData/>'));
  metaSheet.size = metaSheet.content.length;
  const plain = await workbookFromFile(X.CFB.write(stripped, { type: 'array', fileType: 'zip' }), 'plain.xlsx');
  expect(plain.getCell(plain.activeSheetId, 0, 0)).toMatchObject({ v: '=1+', f: null });
  expect(plain.getDisplay(plain.activeSheetId, 0, 0)).toBe('=1+');
  // Excel replaced the text of A1 with a value: the stale sidecar entry does not bring the typo back.
  const data = X.CFB.find(zip, '/xl/worksheets/sheet1.xml');
  const text = new TextDecoder().decode(data.content);
  expect(text).toMatch(/<c r="A1"[^>]*t="str"><v>=1\+<\/v><\/c>/);
  data.content = new TextEncoder().encode(text.replace('<v>=1+</v>', '<v>fixed</v>'));
  data.size = data.content.length;
  const edited = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'edited.xlsx');
  expect(edited.getCell(edited.activeSheetId, 0, 0)).toMatchObject({ v: 'fixed', f: null });
  expect(edited.getCell(edited.activeSheetId, 1, 0)).toMatchObject({ v: null, f: '1 2' });
});

it('does the same through .ods, restoring from the settings block and leaving text without it', async () => {
  const wb = typed();
  const back = await workbookFromFile(await workbookToOds(wb), 'typed.ods');
  BROKEN.forEach((text, r) => expect(back.getCell(back.activeSheetId, r, 0)).toMatchObject({ v: null, f: text.slice(1) }));
  expect(back.getCell(back.activeSheetId, 0, 1)).toMatchObject({ f: '1+1' });
  const plainBlob = await workbookToOds(wb, { settings: false });
  const content = await partsOf(plainBlob, 'content.xml');
  expect(content).not.toMatch(/of:=1\+"|of:=1 2"|of:=&quot;abc"|of:=\)"/);
  expect(content).toContain('of:=1+1"');
  expect(content).toContain('<text:p>=1+</text:p>');
  const plain = await workbookFromFile(plainBlob, 'plain.ods');
  expect(plain.getCell(plain.activeSheetId, 0, 0)).toMatchObject({ v: '=1+', f: null });
});
