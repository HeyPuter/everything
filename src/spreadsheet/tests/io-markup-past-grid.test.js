import { expect, it } from 'vitest';
import { workbookFromFile, workbookToXlsx, workbookToOds } from '../src/core/io.js';
import { MAX_ROW, MAX_COL } from '../src/core/refs.js';

// An Excel 2003 XML spreadsheet, a SYLK file or a web page can place a cell anywhere: one past
// row 1,048,576 or column XFD was kept as a cell the grid could not show, and saving the book
// then wrote a cell Excel refuses, so neither Excel nor this app could open the saved .xlsx (or
// .ods) again. Such cells are left out now and counted, as a delimited file's are.

const bytes = (text) => new TextEncoder().encode(text);
const spreadsheetMl = (rows) => bytes('<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>'
  + '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'
  + `<Worksheet ss:Name="Data"><Table>${rows}</Table></Worksheet></Workbook>`);

it('leaves out the cells of an Excel 2003 XML file past the grid and counts them', async () => {
  const wb = await workbookFromFile(spreadsheetMl('<Row><Cell><Data ss:Type="Number">1</Data></Cell></Row>'
    + `<Row ss:Index="${MAX_ROW + 2}"><Cell><Data ss:Type="Number">2</Data></Cell><Cell ss:Index="${MAX_COL + 5}"><Data ss:Type="Number">3</Data></Cell></Row>`
    + `<Row ss:Index="${MAX_ROW + 3}"><Cell><Data ss:Type="String">x</Data></Cell></Row>`), 'report.xml');
  const sheet = wb.sheets[0];
  expect([...sheet.cells.keys()]).toEqual(['0,0']);
  expect(wb.usedRange(sheet.id)).toEqual({ r1: 0, c1: 0, r2: 0, c2: 0 });
  expect(wb.importTruncated).toEqual({ rows: 2, cols: 4 });
});

it('saves a book read from such a file as an .xlsx and an .ods that open again', async () => {
  const wb = await workbookFromFile(spreadsheetMl('<Row><Cell><Data ss:Type="Number">1</Data></Cell></Row>'
    + `<Row ss:Index="${MAX_ROW + 2}"><Cell><Data ss:Type="Number">2</Data></Cell></Row>`), 'report.xml');
  const xlsx = await workbookFromFile(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), 'report.xlsx');
  expect(xlsx.getValue(xlsx.activeSheetId, 0, 0)).toBe(1);
  const ods = await workbookFromFile(new Uint8Array(await (await workbookToOds(wb)).arrayBuffer()), 'report.ods');
  expect(ods.getValue(ods.activeSheetId, 0, 0)).toBe(1);
});

it('leaves out a SYLK cell past the last column', async () => {
  const wb = await workbookFromFile(bytes(`ID;P\nC;Y1;X1;K1\nC;Y1;X${MAX_COL + 3};K2\nE\n`), 'data.slk');
  expect([...wb.sheets[0].cells.keys()]).toEqual(['0,0']);
  expect(wb.importTruncated).toEqual({ rows: 0, cols: 2 });
});

it('says nothing of a file that fits the grid, even at its last cell', async () => {
  const wb = await workbookFromFile(spreadsheetMl(`<Row ss:Index="${MAX_ROW + 1}"><Cell ss:Index="${MAX_COL + 1}"><Data ss:Type="Number">7</Data></Cell></Row>`), 'edge.xml');
  expect(wb.getValue(wb.activeSheetId, MAX_ROW, MAX_COL)).toBe(7);
  expect(wb.importTruncated).toBeUndefined();
});
