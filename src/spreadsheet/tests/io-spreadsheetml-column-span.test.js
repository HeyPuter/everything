import { expect, it } from 'vitest';
import { workbookFromFile } from '../src/core/io.js';
import * as X from '../src/vendor/xlsx.mjs';

// An Excel 2003 XML spreadsheet gives a run of alike columns as one <Column> with ss:Span. The reader
// made a copy of the column for every one spanned, with no regard to the sheet's 16,384 columns, so
// ss:Span="99999999" in a file of a few hundred bytes ran the tab out of memory, and an ss:Index that
// far made a list as long. Columns past the last are not read now, and a span stops there.

const file = (columns) => new TextEncoder().encode('<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>'
  + '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'
  + `<Worksheet ss:Name="Data"><Table>${columns}<Row><Cell><Data ss:Type="Number">1</Data></Cell></Row></Table></Worksheet></Workbook>`);

it('reads no more columns than a sheet has', () => {
  const book = X.read(file('<Column ss:Width="150" ss:Span="100000"/>'), { type: 'array', cellStyles: true });
  expect(book.Sheets.Data['!cols']).toHaveLength(16384);
  const far = X.read(file('<Column ss:Index="5000000" ss:Width="150"/>'), { type: 'array', cellStyles: true });
  expect(far.Sheets.Data['!cols'] || []).toHaveLength(0);
});

it('opens a file whose column spans a hundred million columns', async () => {
  const started = performance.now();
  const wb = await workbookFromFile(file('<Column ss:Width="150" ss:Span="99999999"/>'), 'wide.xml');
  expect(performance.now() - started).toBeLessThan(5000);
  expect(wb.getValue(wb.activeSheetId, 0, 0)).toBe(1);
  expect(Math.max(...wb.activeSheet.colWidths.keys())).toBe(16383);
});

it('still gives each spanned column its width', async () => {
  const wb = await workbookFromFile(file('<Column ss:Index="3" ss:Width="150"/><Column ss:Width="180" ss:Span="2"/>'), 'cols.xml');
  const widths = wb.activeSheet.colWidths;
  expect([...widths.keys()].sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
  expect(widths.get(3)).toBe(widths.get(5));
  expect(widths.get(3)).toBeGreaterThan(widths.get(2));
});
