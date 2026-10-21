import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { normalizeNormalFont, normalizeNativeWidths } from '../src/core/normal-font.js';
import { xlsxColumnPixels, xlsxWidthFromPixels } from '../src/core/xlsx-styles.js';
import { otherProgramsXlsx } from './helpers/xlsx-fixture.js';

function source({ name = 'Geneva', size = 10, fontId = 2, defaultFontId = 0, xfId = 1, extra = '', head = '' } = {}) {
  const fonts = Array.from({ length: fontId + 1 }, (_, i) => i === fontId
    ? `<font>${extra}<sz val="${size}"/><name val="${name}"/></font>`
    : '<font><sz val="12"/><name val="Calibri"/></font>');
  const xfs = Array.from({ length: xfId + 1 }, (_, i) => `<xf fontId="${i === xfId ? fontId : 0}" numFmtId="0" fillId="0" borderId="0"/>`);
  return otherProgramsXlsx({ sheetXml: { Data: {
    head: head || '<sheetFormatPr defaultColWidth="11.25"/><cols><col min="1" max="1" width="26.75390625" customWidth="1"/><col min="3" max="3" width="5.125" hidden="1"/></cols>',
    rows: '<row r="2"><c r="A2" t="inlineStr"><is><t>Different cell font</t></is></c><c r="B2" s="1"><v>45</v></c></row>',
  } }, patch: { '/xl/styles.xml': () => '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<fonts count="${fonts.length}">${fonts.join('')}</fonts>`
    + '<fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders>'
    + `<cellStyleXfs count="${xfs.length}">${xfs.join('')}</cellStyleXfs>`
    + `<cellXfs count="2"><xf fontId="${defaultFontId}" numFmtId="0" fillId="0" borderId="0" xfId="${xfId}"/><xf fontId="${fontId}" numFmtId="0" fillId="0" borderId="0" xfId="${xfId}"/></cellXfs>`
    + `<cellStyles count="1"><cellStyle name="標準" xfId="${xfId}" builtinId="0"/></cellStyles></styleSheet>` } });
}
async function exported(wb) {
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  const text = path => new TextDecoder().decode(X.CFB.find(zip, path).content);
  const native = () => {
    const part = X.CFB.find(zip, '/xl/workbook.xml');
    part.content = new TextEncoder().encode(text('/xl/workbook.xml').replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
    part.size = part.content.length;
    return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
  };
  return { text, native };
}

it.each([[0, 0], [2, 1], [3, 2]])('resolves Normal through built-in style %i and font %i, preserving native units and edits', async (fontId, xfId) => {
  let wb = await workbookFromFile(source({ fontId, xfId }), 'normal.xlsx');
  expect(wb.normalFont).toEqual({ name: 'Geneva', sz: 10, color: 'windowtext' });
  const id = wb.activeSheetId;
  expect(wb.colWidth(id, 0)).toBe(241);
  expect(wb.activeSheet.defaultColWidth).toBe(101);
  expect(wb.colWidth(id, 2)).toBe(0);
  expect(wb.activeSheet.colWidths.get(2)).toBe(46);
  if (fontId) expect(wb.getCell(id, 1, 0).s).toMatchObject({ font: 'calibri', size: 16 });
  wb.setColWidth(id, 1, 173);
  const draft = new Workbook(wb.toJSON());
  expect(draft.normalFont).toEqual(wb.normalFont);
  expect(draft.normalFont).not.toBe(wb.normalFont);
  const out = await exported(draft);
  expect(out.text('/xl/styles.xml')).toContain('<font><sz val="10"/><color auto="1"/><name val="Geneva"/></font>');
  expect(out.text('/xl/worksheets/sheet1.xml')).toContain('width="26.75390625"');
  wb = await workbookFromFile(out.native(), 'native.xlsx');
  expect(wb.normalFont).toEqual(draft.normalFont);
  expect([wb.colWidth(wb.activeSheetId, 0), wb.colWidth(wb.activeSheetId, 1), wb.activeSheet.colWidths.get(2)]).toEqual([241, 173, 46]);
  expect(wb.getValue(wb.activeSheetId, 1, 1)).toBe(45);
});

it.each(['<sheetFormatPr defaultRowHeight="14"/>', '<sheetFormatPr baseColWidth="9" defaultRowHeight="14"/>'])('retains implicit native default widths for unavailable fonts: %s', async head => {
  const wb = await workbookFromFile(source({ name: 'Unavailable &amp; Custom Font', size: 13, head }), 'unavailable.xlsx');
  const out = await exported(wb);
  const format = out.text('/xl/worksheets/sheet1.xml').match(/<sheetFormatPr[^>]*>/)[0];
  expect(format).not.toContain('defaultColWidth');
  expect(format.includes('baseColWidth="9"')).toBe(head.includes('baseColWidth'));
  expect(out.text('/xl/styles.xml')).toContain('name val="Unavailable &amp; Custom Font"');
  expect((await workbookFromFile(out.native(), 'back.xlsx')).activeSheet.defaultColWidth).toBe(wb.activeSheet.defaultColWidth);
});

it('preserves unknown-font explicit widths and uses a stable fallback for resized columns', async () => {
  const wb = await workbookFromFile(source({ name: 'Unavailable Font', size: 13 }), 'unknown.xlsx');
  wb.setColWidth(wb.activeSheetId, 1, 182);
  const out = await exported(wb);
  expect(out.text('/xl/worksheets/sheet1.xml')).toContain('width="26.75390625"');
  const back = await workbookFromFile(out.native(), 'native.xlsx');
  expect(back.colWidth(back.activeSheetId, 0)).toBe(wb.colWidth(wb.activeSheetId, 0));
  expect(back.colWidth(back.activeSheetId, 1)).toBe(182);
});

it.each([0, 2])('keeps Normal font properties in Excel-compatible order at font index %i', async fontId => {
  const wb = await workbookFromFile(source({ name: 'Arial', size: 11, fontId, extra: '<b/><i/><strike/><condense/><extend/><outline/><shadow/><u val="double"/><vertAlign val="superscript"/><color rgb="FF123456"/><family val="2"/><charset val="128"/>' }), 'properties.xlsx');
  const font = (await exported(wb)).text('/xl/styles.xml').match(/<fonts[^>]*>(<font>[\s\S]*?<\/font>)/)[1];
  expect(font).toBe('<font><b/><i/><strike/><condense/><extend/><outline/><shadow/><u val="double"/><vertAlign val="superscript"/><sz val="11"/><color rgb="FF123456"/><name val="Arial"/><family val="2"/><charset val="128"/></font>');
  expect(wb.getCell(wb.activeSheetId, 1, 1).s).toMatchObject({ bold: true, italic: true, underline: 'double', strike: true, color: '#123456' });
});

it('copies cell fonts in both directions without changing either workbook Normal font or column geometry', async () => {
  const left = await workbookFromFile(source(), 'geneva.xlsx');
  const right = await workbookFromFile(source({ name: 'Arial', size: 16 }), 'arial.xlsx');
  const range = { r1: 1, c1: 1, r2: 1, c2: 1 };
  const leftCells = left.copyRange(left.activeSheetId, range), rightCells = right.copyRange(right.activeSheetId, range);
  for (const [target, cells, name] of [[left, rightCells, 'Geneva'], [right, leftCells, 'Arial']]) {
    const width = target.colWidth(target.activeSheetId, 0);
    target.pasteCells(target.activeSheetId, cells, 5, 0);
    expect(target.getCell(target.activeSheetId, 5, 0).s).toEqual(cells[0][0].s);
    expect(target.normalFont.name).toBe(name);
    const back = await workbookFromFile((await exported(target)).native(), 'pasted.xlsx');
    expect(back.colWidth(back.activeSheetId, 0)).toBe(width);
    const displayed = back.styleAt(back.activeSheetId, 5, 0);
    const { bold, italic, underline, strike, ...rest } = cells[0][0].s;
    expect(displayed).toMatchObject(rest);
    for (const [key, value] of Object.entries({ bold, italic, underline, strike })) expect(!!displayed[key]).toBe(!!value);
  }
});

it('moves native width records with columns, restores them on undo and clones them independently', async () => {
  const wb = await workbookFromFile(source(), 'moves.xlsx'), id = wb.activeSheetId;
  wb.insertCols(id, 0, 2);
  expect(wb.sheet(id).nativeWidths.cols[2].width).toBe(26.75390625);
  wb.deleteCols(id, 1, 1);
  expect(wb.sheet(id).nativeWidths.cols[1].width).toBe(26.75390625);
  wb.undo(); wb.undo();
  expect(wb.sheet(id).nativeWidths.cols[0].width).toBe(26.75390625);
  const copy = wb.duplicateSheet(id);
  copy.nativeWidths.cols[0].width = 2;
  expect(wb.sheet(id).nativeWidths.cols[0].width).toBe(26.75390625);
});

it('converts widths against the destination Normal font when sheets are imported into another workbook', async () => {
  const sourceWb = await workbookFromFile(source(), 'source.xlsx');
  const target = new Workbook({ normalFont: { name: 'Arial', sz: 16 } });
  const [sheet] = target.importSheets(sourceWb);
  const expected = target.colWidth(sheet.id, 0);
  const out = await exported(target);
  const back = await workbookFromFile(out.native(), 'combined.xlsx');
  expect(back.normalFont).toEqual({ name: 'Arial', sz: 16, color: 'windowtext' });
  expect(back.colWidth(back.sheets[1].id, 0)).toBe(expected);
});

it('rejects malformed font and dimension metadata', () => {
  for (const value of [null, {}, { name: 'Arial', sz: Infinity }, { name: 'Bad\nFont', sz: 12 }, { name: 'Arial', sz: -1 }]) expect(normalizeNormalFont(value)).toBeNull();
  expect(normalizeNativeWidths({ font: { name: 'Arial', sz: 12 }, cols: { 0: { width: Infinity, pixels: 30 }, 16384: { width: 5, pixels: 50 }, 2: { width: 7, pixels: NaN } } }).cols).toEqual({});
});

it.each([{ name: 'Geneva', sz: 10 }, { name: 'Arial', sz: 16 }, { name: 'Calibri', sz: 12 }])('inverts pixel widths using the Normal font %j', font => {
  for (const pixels of [1, 5, 27, 64, 101, 173, 999]) expect(xlsxColumnPixels({ width: xlsxWidthFromPixels(pixels, font) }, font)).toBe(pixels);
});

it('inherits Normal on blank cells and new input when XF zero selects its font, including sidecar-free native export', async () => {
  let wb = await workbookFromFile(source({ name: 'Courier New', size: 14, defaultFontId: 2, extra: '<b/><i/>' }), 'defaults.xlsx');
  const style = { font: 'courier', size: 56 / 3, bold: true, italic: true, color: 'windowtext', valign: 'bottom' };
  expect(wb.styleAt(wb.activeSheetId, 50, 8)).toEqual(style);
  expect(wb.getCell(wb.activeSheetId, 50, 8)).toBeUndefined();
  wb.setInput(wb.activeSheetId, 50, 8, 'New text');
  expect(wb.displayStyleAt(wb.activeSheetId, 50, 8)).toMatchObject(style);
  const bytes = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
  const own = await workbookFromFile(bytes, 'own.xlsx');
  expect(own.displayStyleAt(own.activeSheetId, 50, 8)).toMatchObject(style);
  wb = await workbookFromFile((await exported(wb)).native(), 'native.xlsx');
  expect(wb.displayStyleAt(wb.activeSheetId, 50, 8)).toMatchObject(style);
  expect(wb.styleAt(wb.activeSheetId, 100, 10)).toEqual(style);
});

it('does not impose Normal font flags or color on cells that select another complete font record', async () => {
  const wb = await workbookFromFile(source({ extra: '<b/><i/><u/><strike/><color rgb="FF123456"/>' }), 'flags.xlsx');
  expect(wb.styleAt(wb.activeSheetId, 1, 0)).toMatchObject({ font: 'calibri', bold: false, italic: false, underline: false, strike: false, color: 'windowtext' });
  expect(wb.styleAt(wb.activeSheetId, 1, 1)).toMatchObject({ font: 'font:Geneva', bold: true, italic: true, underline: true, strike: true, color: '#123456' });
});

it('layers line/cell formats over Normal and restores the base through Clear formats and undo', () => {
  const wb = new Workbook({ normalFont: { name: 'Arial', sz: 15, bold: true }, sheets: [{ name: 'Data', colStyles: { 0: { font: 'courier', bold: false } }, rowStyles: { 1: { size: 32 } } }] });
  const id = wb.activeSheetId, cell = { r1: 1, c1: 0, r2: 1, c2: 0 };
  expect(wb.styleAt(id, 1, 0)).toMatchObject({ font: 'courier', size: 32, bold: false });
  wb.clearRange(id, cell, { contents: false, styles: true });
  expect(wb.styleAt(id, 1, 0)).toEqual({ font: 'arial', size: 20, bold: true });
  wb.undo();
  expect(wb.styleAt(id, 1, 0)).toMatchObject({ font: 'courier', size: 32, bold: false });
  wb.toggleStyle(id, { r1: 0, c1: 2, r2: 99, c2: 2 }, 'bold', { r: 0, c: 2 });
  expect(wb.styleAt(id, 200, 2).bold).toBeNull();
  expect(new Workbook(wb.toJSON()).styleAt(id, 200, 2).bold).toBeNull();
  wb.undo();
  expect(wb.styleAt(id, 200, 2).bold).toBe(true);
});

it('copies inherited formatting from blank and populated cells without filling the worksheet', () => {
  const wb = new Workbook({ normalFont: { name: 'Georgia', sz: 17 } }), id = wb.activeSheetId;
  expect(wb.usedRange(id)).toBeNull();
  expect(wb.activeSheet.cells.size).toBe(0);
  const cells = wb.copyRange(id, { r1: 2, c1: 3, r2: 3, c2: 3 });
  expect(cells[0][0].s).toMatchObject({ font: 'georgia', size: 68 / 3, bold: false, color: '#000000' });
  const target = new Workbook({ normalFont: { name: 'Arial', sz: 11, bold: true, italic: true, color: '#123456' } });
  target.pasteCells(target.activeSheetId, cells, 0, 0);
  expect(target.styleAt(target.activeSheetId, 1, 0)).toEqual(cells[0][0].s);
  expect(wb.activeSheet.cells.size).toBe(0);
  wb.setInput(id, 2, 3, 'Typed');
  expect(wb.copyCells(id, [2], [3])[0][0].s).toEqual(cells[0][0].s);
});
