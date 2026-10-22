import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { ymdToSerial, todaySerial } from '../src/core/format.js';

const part = (bytes, path) => new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), path).content);

/**
 * An .xlsx with a list in A1:B9 (B2:B9 holding `values`, filled red where `red` says), an autoFilter whose
 * column B condition is `condition`, and the rows `hidden` hidden as the file's filter left them.
 */
function file(condition, values, hidden, red = []) {
  const book = X.utils.book_new();
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet([['x']]), 'Data');
  const zip = X.CFB.read(new Uint8Array(X.write(book, { type: 'array', bookType: 'xlsx' })), { type: 'array' });
  const edit = (path, fn) => { const e = X.CFB.find(zip, path); e.content = new TextEncoder().encode(fn(new TextDecoder().decode(e.content))); e.size = e.content.length; };
  let rows = '<row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c></row>';
  values.forEach((v, i) => {
    const r = i + 2;
    rows += `<row r="${r}"${hidden.includes(r) ? ' hidden="1"' : ''}><c r="A${r}" t="inlineStr"><is><t>n${r}</t></is></c><c r="B${r}"${red.includes(r) ? ' s="1"' : ''}><v>${v}</v></c></row>`;
  });
  edit('/xl/worksheets/sheet1.xml', () => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<x:sheetData>${rows.replace(/<(\/?)(row|c|is|t|v)\b/g, '<$1x:$2')}</x:sheetData><x:autoFilter ref="A1:B9"><x:filterColumn colId="1">${condition}</x:filterColumn></x:autoFilter></x:worksheet>`);
  edit('/xl/styles.xml', (xml) => xml
    .replace(/<fills count="\d+">/, '<fills count="3">').replace('</fills>', '<fill><patternFill patternType="solid"><fgColor rgb="FFFF0000"/><bgColor indexed="64"/></patternFill></fill></fills>')
    .replace(/<cellXfs count="\d+">([\s\S]*?)<\/cellXfs>/, (m, xfs) => `<cellXfs count="2">${xfs.match(/<xf\b[^>]*\/>|<xf\b[\s\S]*?<\/xf>/)[0]}<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/></cellXfs>`)
    .replace(/<dxfs[^>]*\/>|<dxfs[\s\S]*?<\/dxfs>/, '').replace('</styleSheet>', '<dxfs count="1"><dxf><fill><patternFill patternType="solid"><fgColor rgb="FFFF0000"/><bgColor rgb="FFFF0000"/></patternFill></fill></dxf></dxfs></styleSheet>'));
  return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
}
const hiddenRows = (wb) => [...Array(9).keys()].filter((r) => wb.isRowHidden(wb.activeSheetId, r)).map((r) => r + 1);
const values = [20, 30, 40, 50, 60, 70, 80, 90];

// A filter Excel wrote with a condition this app has no criterion for (Top 10, above average, a period of
// dates, the dates ticked in the list, a colour, an icon) opened with no condition at all: the next save
// wrote the filter without it, so Excel's Reapply then showed every row, and Reapply here could not redo it.
// The condition now goes back into the file as it came, and the rows are judged by it where it can be.
it.each([
  ['top ten', '<x:top10 top="1" val="3"/>', values, [2, 3, 4, 5, 6]],
  ['bottom 25 percent', '<x:top10 top="0" percent="1" val="25"/>', values, [4, 5, 6, 7, 8, 9]],
  ['above average', '<x:dynamicFilter type="aboveAverage" val="55"/>', values, [2, 3, 4, 5]],
  ['dates ticked in the list', '<x:filters><x:dateGroupItem year="2024" month="3" dateTimeGrouping="month"/><x:filter val="n9"/></x:filters>',
    [ymdToSerial(2024, 3, 5), ymdToSerial(2024, 4, 1), ymdToSerial(2023, 3, 5), ymdToSerial(2024, 3, 31), 1, 2, 3, 4], [3, 4, 6, 7, 8, 9]],
  ['this month', '<x:dynamicFilter type="thisMonth"/>', [todaySerial(), todaySerial() - 40, todaySerial() + 40, todaySerial(), 1, 2, 3, 4], [3, 4, 6, 7, 8, 9]],
  ['a quarter', '<x:dynamicFilter type="Q2"/>', [ymdToSerial(2024, 5, 1), ymdToSerial(2023, 4, 30), ymdToSerial(2024, 7, 1), 4, 5, 6, 7, 8], [4, 5, 6, 7, 8, 9]],
  ['a wildcard pattern', '<x:customFilters><x:customFilter val="?0"/><x:customFilter val="2?"/></x:customFilters>', values, []],
  ['two wildcard patterns joined by and', '<x:customFilters and="1"><x:customFilter val="?0"/><x:customFilter val="2?"/></x:customFilters>', values, [3, 4, 5, 6, 7, 8, 9]],
])('keeps an Excel %s filter through a save and judges rows by it', async (_, condition, column, hidden) => {
  let wb = await workbookFromFile(file(condition, column, hidden), 'filtered.xlsx');
  for (let round = 0; round < 2; round++) {
    expect(hiddenRows(wb)).toEqual(hidden);
    wb.reapplyFilter(wb.activeSheetId);
    expect(hiddenRows(wb)).toEqual(hidden);
    const bytes = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
    expect(part(bytes, '/xl/worksheets/sheet1.xml')).toContain(`<filterColumn colId="1">${condition.replace(/x:/g, '')}</filterColumn>`);
    wb = await workbookFromFile(bytes, 'saved.xlsx');
  }
});

it('judges a colour filter by the fill its format names, and keeps an icon filter as written', async () => {
  const red = [3, 5];
  const wb = await workbookFromFile(file('<x:colorFilter dxfId="0"/>', values, [2, 4, 6, 7, 8, 9], red), 'colours.xlsx');
  wb.reapplyFilter(wb.activeSheetId);
  expect(hiddenRows(wb)).toEqual([2, 4, 6, 7, 8, 9]);
  // The format it names is renumbered with the book's own; it is still the red fill.
  const bytes = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
  const dxfId = Number(part(bytes, '/xl/worksheets/sheet1.xml').match(/<filterColumn colId="1"><colorFilter dxfId="(\d+)"\/><\/filterColumn>/)[1]);
  const dxf = part(bytes, '/xl/styles.xml').match(/<dxfs[^>]*>([\s\S]*?)<\/dxfs>/)[1].match(/<dxf>[\s\S]*?<\/dxf>/g)[dxfId];
  expect(dxf).toMatch(/FFFF0000/i);
  const again = await workbookFromFile(bytes, 'saved.xlsx');
  again.reapplyFilter(again.activeSheetId);
  expect(hiddenRows(again)).toEqual([2, 4, 6, 7, 8, 9]);
  const icons = await workbookFromFile(file('<x:iconFilter iconSet="3Arrows" iconId="0"/>', values, [2, 3]), 'icons.xlsx');
  expect(hiddenRows(icons)).toEqual([2, 3]);
  expect(part(new Uint8Array(await (await workbookToXlsx(icons)).arrayBuffer()), '/xl/worksheets/sheet1.xml')).toContain('<filterColumn colId="1"><iconFilter iconSet="3Arrows" iconId="0"/></filterColumn>');
});
