// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { workbookFromFile } from '../src/core/io.js';
import { importNameFor } from '../src/core/importrange.js';

const values = (wb) => [0, 1].map((r) => [0, 1].map((c) => wb.getValue(wb.activeSheetId, r, c)));

// File ▸ Import from URL names what an address without a file name serves, so the importer knows its kind.
// Anything but a zip was named .csv, and a .csv is read as delimited text whatever its bytes: an "export to
// Excel" link serving a web page's table or an Excel 2003 XML sheet (as banks and report tools do) arrived as
// lines of markup. Markup and binary .xls are named .xls now, which the importer reads by their bytes.
it('imports a web page table served from an address without a file name as its table', async () => {
  const bytes = new TextEncoder().encode('<html><body><table><tr><td>Item</td><td>Price</td></tr><tr><td>Tea</td><td>4.50</td></tr></table></body></html>');
  const name = importNameFor('https://bank.example/statements/export?format=xls', bytes);
  expect(name).toBe('export.xls');
  expect(values(await workbookFromFile(bytes, name))).toEqual([['Item', 'Price'], ['Tea', 4.5]]);
});

it('imports an Excel 2003 XML sheet served from an address without a file name', async () => {
  const bytes = new TextEncoder().encode('<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Report"><Table><Row><Cell><Data ss:Type="String">Item</Data></Cell><Cell><Data ss:Type="String">Price</Data></Cell></Row><Row><Cell><Data ss:Type="String">Tea</Data></Cell><Cell><Data ss:Type="Number">4.5</Data></Cell></Row></Table></Worksheet></Workbook>');
  const name = importNameFor('https://reports.example/run/42', bytes);
  expect(name).toBe('42.xls');
  expect(values(await workbookFromFile(bytes, name))).toEqual([['Item', 'Price'], ['Tea', 4.5]]);
});

it('still names delimited text and binary workbooks by what they are', () => {
  expect(importNameFor('https://x.org/api/rows', new TextEncoder().encode('a,b\n1,2'))).toBe('rows.csv');
  expect(importNameFor('https://x.org/api/rows', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1]))).toBe('rows.xls');
});
