import { expect, it } from 'vitest';
import { workbookFromFile } from '../src/core/io.js';

// Excel 2003 XML writes a cell holding no value as an empty element, <Cell ss:MergeAcross="2"
// ss:StyleID="s62"/>. The reader only counted such a cell's column: an empty merged heading's span
// was not counted, so the cells after it landed that many columns to the left, and the merged block,
// the cell's format, a formula with no value cached and a comment on a cell with no value were lost.

const file = (rows) => new TextEncoder().encode('<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>'
  + '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'
  + '<Styles><Style ss:ID="fill"><Interior ss:Color="#FFFF00" ss:Pattern="Solid"/></Style></Styles>'
  + `<Worksheet ss:Name="Data"><Table>${rows}</Table></Worksheet></Workbook>`);

it('puts the cells after an empty merged block in their own columns', async () => {
  const wb = await workbookFromFile(file('<Row><Cell ss:MergeAcross="2" ss:StyleID="fill"/><Cell><Data ss:Type="String">Total</Data></Cell></Row>'), 'merged.xml');
  const sheet = wb.activeSheet;
  expect(wb.getValue(sheet.id, 0, 3)).toBe('Total');
  expect(wb.getValue(sheet.id, 0, 1)).toBe(null);
  expect(sheet.merges).toEqual([{ r1: 0, c1: 0, r2: 0, c2: 2 }]);
  expect(wb.getCell(sheet.id, 0, 0)?.s?.bg).toBe('#ffff00');
});

it('keeps an empty cell\'s format, a formula with no value and a comment on an empty cell', async () => {
  const wb = await workbookFromFile(file('<Row><Cell><Data ss:Type="Number">3</Data></Cell><Cell ss:StyleID="fill"/>'
    + '<Cell ss:Formula="=RC[-2]*2"/><Cell ss:Formula="=1+1"></Cell><Cell><Comment ss:Author="Ann"><Data>Look here</Data></Comment></Cell>'
    + '<Cell><Data ss:Type="Number">6</Data></Cell></Row>'), 'empty.xml');
  const id = wb.activeSheetId;
  expect(wb.getCell(id, 0, 1)?.s?.bg).toBe('#ffff00');
  expect(wb.getCell(id, 0, 2)?.f).toBe('A1*2');
  expect(wb.getValue(id, 0, 2)).toBe(6);
  expect(wb.getValue(id, 0, 3)).toBe(2);
  expect(wb.getNote(id, 0, 4)).toBe('Look here');
  expect(wb.getValue(id, 0, 5)).toBe(6);
});

it('stores nothing for a bare empty cell', async () => {
  const wb = await workbookFromFile(file('<Row><Cell/><Cell><Data ss:Type="Number">2</Data></Cell></Row>'), 'bare.xml');
  expect([...wb.activeSheet.cells.keys()]).toEqual(['0,1']);
});
