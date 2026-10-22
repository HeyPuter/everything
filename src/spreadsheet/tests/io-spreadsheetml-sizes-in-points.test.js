import { expect, it } from 'vitest';
import { workbookFromFile } from '../src/core/io.js';

// An Excel 2003 XML spreadsheet gives row heights and column widths in points: ss:Height="15" is a
// standard row of 20 pixels and ss:Width="48" a standard column of 64. They were read as pixels, so
// every sized row and column opened a quarter too small, cutting off the text Excel showed in them.

const file = (table) => new TextEncoder().encode('<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>'
  + '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'
  + `<Worksheet ss:Name="Data"><Table>${table}</Table></Worksheet></Workbook>`);
const number = (n) => `<Cell><Data ss:Type="Number">${n}</Data></Cell>`;

it('reads row heights and column widths as points', async () => {
  const wb = await workbookFromFile(file(`<Column ss:Width="96.75"/><Column ss:Width="150"/><Column ss:Width="48"/>`
    + `<Row ss:AutoFitHeight="0" ss:Height="30">${number(1)}</Row><Row ss:Height="45">${number(2)}</Row>`), 'sizes.xml');
  const sheet = wb.activeSheet;
  expect(sheet.colWidths.get(0)).toBe(129);
  expect(sheet.colWidths.get(1)).toBe(200);
  expect(sheet.colWidths.get(2)).toBe(64); // Excel's standard width
  expect(sheet.rowHeights.get(0)).toBe(40);
  expect(sheet.rowHeights.get(1)).toBe(60);
});
