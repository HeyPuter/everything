import { expect, it } from 'vitest';
import { workbookFromFile } from '../src/core/io.js';
import { MAX_ROW, MAX_COL } from '../src/core/refs.js';
import * as X from '../src/vendor/xlsx.mjs';

// An Excel 2003 XML spreadsheet spells a merged block as its first cell's ss:MergeAcross and
// ss:MergeDown. The reader made an empty placeholder for every cell the block covers, so a
// block of whole columns cost a million objects and a second, and one across the whole sheet
// (17 billion cells) never finished: opening the file hung the tab. The block is read from its
// first cell alone now.

const file = (cell) => new TextEncoder().encode('<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>'
  + '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'
  + `<Worksheet ss:Name="Data"><Table><Row>${cell}<Cell><Data ss:Type="String">next</Data></Cell></Row>`
  + '<Row><Cell ss:Index="3"><Data ss:Type="Number">2</Data></Cell></Row></Table></Worksheet></Workbook>');

it('opens a block merged across the whole sheet at once', async () => {
  const started = performance.now();
  const wb = await workbookFromFile(file(`<Cell ss:MergeAcross="${MAX_COL}" ss:MergeDown="${MAX_ROW}"><Data ss:Type="String">Title</Data></Cell>`), 'whole.xml');
  expect(performance.now() - started).toBeLessThan(5000);
  const sheet = wb.sheets[0];
  expect(sheet.merges).toEqual([{ r1: 0, c1: 0, r2: MAX_ROW, c2: MAX_COL }]);
  expect(wb.getValue(sheet.id, 0, 0)).toBe('Title');
});

it('keeps the cells beside and below a merged block where the file puts them', async () => {
  const wb = await workbookFromFile(file('<Cell ss:MergeAcross="1" ss:MergeDown="2"><Data ss:Type="String">Title</Data></Cell>'), 'block.xml');
  const sheet = wb.sheets[0];
  expect(sheet.merges).toEqual([{ r1: 0, c1: 0, r2: 2, c2: 1 }]);
  expect([...sheet.cells.keys()].sort()).toEqual(['0,0', '0,2', '1,2']);
  expect(wb.getValue(sheet.id, 0, 2)).toBe('next');
  expect(wb.getValue(sheet.id, 1, 2)).toBe(2);
});

it('stores nothing for the cells of a block of whole columns', async () => {
  const bytes = file(`<Cell ss:MergeDown="${MAX_ROW}"><Data ss:Type="String">Side</Data></Cell>`);
  // The reader is asked for empty cells, as the app asks it, to keep formatted blanks.
  const book = X.read(bytes, { type: 'array', cellStyles: true, sheetStubs: true });
  expect(Object.keys(book.Sheets.Data).filter((key) => !key.startsWith('!'))).toEqual(['A1', 'B1', 'C2']);
  const wb = await workbookFromFile(bytes, 'column.xml');
  expect(wb.sheets[0].merges).toEqual([{ r1: 0, c1: 0, r2: MAX_ROW, c2: 0 }]);
});
