import { expect, it } from 'vitest';
import { workbookFromFile } from '../src/core/io.js';

// Excel 2003 XML names its built-in number formats (ss:Format="Euro Currency", "On/Off"). Euro
// Currency was missing from the reader's list, so it was read as a code made of its own letters and
// 1234.5 showed as "1903uro Curr1903nc03"; On/Off was given Yes/No's words.

const file = (format) => new TextEncoder().encode('<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>'
  + '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'
  + `<Styles><Style ss:ID="f"><NumberFormat ss:Format="${format}"/></Style></Styles>`
  + '<Worksheet ss:Name="Data"><Table><Row><Cell ss:StyleID="f"><Data ss:Type="Number">1234.5</Data></Cell>'
  + '<Cell ss:StyleID="f"><Data ss:Type="Number">0</Data></Cell></Row></Table></Worksheet></Workbook>');
const shown = async (format) => {
  const wb = await workbookFromFile(file(format), 'formats.xml');
  return [wb.getDisplay(wb.activeSheetId, 0, 0).trim(), wb.getDisplay(wb.activeSheetId, 0, 1).trim()];
};

it('shows Euro Currency as euros', async () => {
  expect(await shown('Euro Currency')).toEqual(['€1,234.50', '€0.00']);
});

it('shows On/Off as On and Off', async () => {
  expect(await shown('On/Off')).toEqual(['On', 'Off']);
  expect(await shown('Yes/No')).toEqual(['Yes', 'No']);
});
