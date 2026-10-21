import { DEFAULT_FONT_COLOR } from '../src/core/font-color.js';
import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { otherProgramsXlsx } from './helpers/xlsx-fixture.js';

// Text styles travel in this app's sidecar; the fonts another program gave its cells were
// ignored (the reader hands on a cell's fill alone), so an Excel file's bold red headings
// opened plain and were saved back plain. Each cell's format is read from the sheet's XML
// and its font from the style table: bold, italic, underline, strikethrough, and a size or
// colour, including the default font. The skeleton's default font is 12 points.
const STYLES = {
  fonts: [
    '<font><b/><sz val="14"/><color rgb="FFFF0000"/><name val="Calibri"/></font>', // fontId 1
    '<font><i/><u/><strike/><sz val="12"/><color theme="1"/><name val="Calibri"/></font>', // 2
    '<font><sz val="12"/><color rgb="FF000000"/><name val="Calibri"/></font>', // 3: the default, spelled out
    '<font><sz val="8"/><color rgb="FF0000FF"/><name val="Arial"/></font>', // 4: small, blue (a palette-indexed colour is not read: the vendor spells it without zero padding)
    '<font><b val="0"/><u val="double"/><sz val="12"/></font>', // 5
  ],
  numFmts: ['<numFmt numFmtId="164" formatCode="0.00"/>'],
  cellXfs: [
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>', // s=1
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>', // s=2
    '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>', // s=3
    '<xf numFmtId="164" fontId="4" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>', // s=4
    '<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0"/>', // s=5
  ],
};
const ROWS = '<row r="1"><c r="A1" s="1" t="inlineStr"><is><t>Title</t></is></c><c r="B1" s="2"><v>2</v></c><c r="C1" s="3"><v>3</v></c><c r="D1" s="4"><v>4</v></c><c r="E1"><v>5</v></c><c r="F1" s="1"><f>B1+1</f><v>3</v></c><c r="G1" s="1"/><c s="5" r="H1"><v>8</v></c></row>';

it('reads the fonts another program gave its cells, and keeps them through a save', async () => {
  const wb = await workbookFromFile(otherProgramsXlsx({ sheetXml: { Data: { rows: ROWS } }, styles: STYLES }), 'report.xlsx');
  const id = wb.activeSheetId;
  expect(wb.getCell(id, 0, 0)).toEqual({ v: 'Title', f: null, s: { valign: 'bottom', scheme: 'none', font: 'calibri', bold: true, size: 56 / 3, color: '#ff0000' } });
  expect(wb.getCell(id, 0, 1).s).toEqual({ valign: 'bottom', scheme: 'none', font: 'calibri', size: 16, color: DEFAULT_FONT_COLOR, italic: true, underline: true, strike: true });
  expect(wb.getCell(id, 0, 2).s).toEqual({ valign: 'bottom', scheme: 'none', font: 'calibri', size: 16, color: '#000000' });
  expect(wb.getCell(id, 0, 3).s).toEqual({ valign: 'bottom', scheme: 'none', fmt: 'number', dec: 2, group: false, size: 32 / 3, font: 'arial', color: '#0000ff' });
  expect(wb.getCell(id, 0, 4).s).toEqual({ valign: 'bottom', scheme: 'minor', font: 'calibri', size: 16, color: DEFAULT_FONT_COLOR });
  expect(wb.getCell(id, 0, 5)).toEqual({ v: null, f: 'B1+1', s: { valign: 'bottom', scheme: 'none', font: 'calibri', bold: true, size: 56 / 3, color: '#ff0000' } });
  expect(wb.getCell(id, 0, 6)).toEqual({ v: null, f: null, s: { valign: 'bottom', scheme: 'none', font: 'calibri', bold: true, size: 56 / 3, color: '#ff0000' } });
  expect(wb.getCell(id, 0, 7).s).toEqual({ scheme: 'none', underline: 'double', color: 'windowtext', valign: 'bottom' }); // attribute order in the file does not matter
  const back = await workbookFromFile(await workbookToXlsx(wb), 'report.xlsx');
  expect(back.getCell(back.activeSheetId, 0, 0).s).toEqual({ valign: 'bottom', scheme: 'none', font: 'calibri', bold: true, size: 56 / 3, color: '#ff0000' });
  expect(back.getCell(back.activeSheetId, 0, 3).s).toMatchObject({ size: 32 / 3, color: '#0000ff', fmt: 'number' });
});

it('reads an external Normal font without imposing it on the app\'s own files', async () => {
  const plain = await workbookFromFile(otherProgramsXlsx({ sheetXml: { Data: { rows: '<row r="1"><c r="A1" s="0"><v>1</v></c></row>' } } }), 'plain.xlsx');
  expect(plain.getCell(plain.activeSheetId, 0, 0).s).toEqual({ valign: 'bottom', scheme: 'minor', font: 'calibri', size: 16, color: DEFAULT_FONT_COLOR });
  const wb = new Workbook();
  wb.setInput(wb.activeSheetId, 0, 0, '1');
  wb.applyStyle(wb.activeSheetId, { r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true });
  const back = await workbookFromFile(await workbookToXlsx(wb), 'mine.xlsx');
  expect(back.getCell(back.activeSheetId, 0, 0).s).toEqual({ bold: true });
});

it('accepts native font edits over stale sidecar styles, including cleared flags', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  wb.setInput(wb.activeSheetId, 0, 0, '1');
  wb.setInput(wb.activeSheetId, 0, 1, '2');
  wb.applyStyle(wb.activeSheetId, { r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true, color: '#00ff00' });
  const saved = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
  const zip = X.CFB.read(saved, { type: 'array' });
  const styles = X.CFB.find(zip, '/xl/styles.xml');
  let xf = 0, fontId = 0;
  const styleXml = new TextDecoder().decode(styles.content)
    .replace(/<fonts count="(\d+)">([\s\S]*?)<\/fonts>/, (m, n, body) => { fontId = Number(n); return `<fonts count="${fontId + 1}">${body}<font><i/><sz val="12"/><color rgb="FFFF0000"/></font></fonts>`; })
    .replace(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/, (m, n, body) => { xf = Number(n); return `<cellXfs count="${xf + 1}">${body}<xf numFmtId="0" fontId="${fontId}" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>`; });
  styles.content = new TextEncoder().encode(styleXml);
  styles.size = styles.content.length;
  const sheet = X.CFB.find(zip, '/xl/worksheets/sheet1.xml');
  const sheetXml = new TextDecoder().decode(sheet.content).replace(/<c r="(?:A1|B1)"[^>]*>/g, head => head.replace(/ s="\d+"/, '').replace(/>$/, ` s="${xf}">`));
  sheet.content = new TextEncoder().encode(sheetXml);
  sheet.size = sheet.content.length;
  const back = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'mine.xlsx');
  // A complete native font replaces changed properties, including an absent
  // bold flag; the old private override must not revive it.
  expect(back.getCell(back.activeSheetId, 0, 0).s).toEqual({ bold: false, color: '#ff0000', italic: true });
  expect(back.getCell(back.activeSheetId, 0, 1).s).toEqual({ italic: true, color: '#ff0000' });
});
