import { expect, it } from 'vitest';
import { workbookFromFile } from '../src/core/io.js';

// An Excel 2003 XML spreadsheet gives row heights and column widths in points (ss:Height="15" is a
// standard row of 20 pixels, ss:Width="48" a standard column of 64), which were read as pixels, so
// every sized row and column opened a quarter too small. An empty row's height and hidden state
// (<Row ss:Height="30"/>) were not read at all, and a row with ss:Span, which stands for that many
// more rows like it, was read as one row, putting every row after it that many rows too high.

const file = (table) => new TextEncoder().encode('<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>'
  + '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'
  + `<Worksheet ss:Name="Data"><Table>${table}</Table></Worksheet></Workbook>`);
const number = (n) => `<Cell><Data ss:Type="Number">${n}</Data></Cell>`;


it('keeps an empty row\'s height and hidden state', async () => {
  const wb = await workbookFromFile(file(`<Row>${number(1)}</Row><Row ss:AutoFitHeight="0" ss:Height="30"/><Row ss:Hidden="1"/><Row>${number(4)}</Row>`), 'empty.xml');
  const sheet = wb.activeSheet;
  expect(sheet.rowHeights.get(1)).toBe(40);
  expect(wb.isRowHidden(sheet.id, 2)).toBe(true);
  expect(wb.getValue(sheet.id, 3, 0)).toBe(4);
});

it('puts the rows after a spanned row where the file means them', async () => {
  const wb = await workbookFromFile(file(`<Row>${number(1)}</Row><Row ss:AutoFitHeight="0" ss:Height="24" ss:Span="2"/>`
    + `<Row>${number(5)}</Row><Row ss:Index="10" ss:Span="3">${number(10)}</Row><Row>${number(14)}</Row>`), 'span.xml');
  const sheet = wb.activeSheet;
  expect([...sheet.cells.keys()]).toEqual(['0,0', '4,0', '9,0', '13,0']);
  expect(wb.getValue(sheet.id, 4, 0)).toBe(5);
  expect(wb.getValue(sheet.id, 13, 0)).toBe(14);
  expect([1, 2, 3].map((r) => sheet.rowHeights.get(r))).toEqual([32, 32, 32]);
  expect(sheet.rowHeights.has(4)).toBe(false);
});

it('spans no further than the sheet, and sizes no long run of spanned rows', async () => {
  const wb = await workbookFromFile(file(`<Row ss:Height="30" ss:Span="99999999"/><Row>${number(1)}</Row>`), 'long.xml');
  const sheet = wb.activeSheet;
  expect(sheet.cells.size).toBe(0);
  expect([...sheet.rowHeights.keys()]).toEqual([0]);
});
