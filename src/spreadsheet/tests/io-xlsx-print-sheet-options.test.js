import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { otherProgramsXlsx } from './helpers/xlsx-fixture.js';

const file = setup => otherProgramsXlsx({ sheetXml: { Data: {
  rows: '<row r="1"><c r="A1"><v>17</v></c></row>', tail: `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><pageSetup orientation="landscape"${setup}/>`,
} } });
const pageSetup = async wb => {
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  return new TextDecoder().decode(X.CFB.find(zip, '/xl/worksheets/sheet1.xml').content).match(/<pageSetup\b[^>]*>/)[0];
};

// Excel's Page Setup ▸ Sheet: print in black and white, in draft quality, the comments at the end of the sheet, and
// cell errors as dashes. Opening the file dropped them, so it printed in colour, with comments and errors, once saved.
it('keeps black and white, draft quality, comments and cell errors through a save', async () => {
  const wb = await workbookFromFile(file(' blackAndWhite="1" draft="true" cellComments="atEnd" errors="dash"'), 'report.xlsx');
  expect(wb.activeSheet.printSettings).toMatchObject({ blackAndWhite: true, draft: true, cellComments: 'atEnd', errors: 'dash' });
  const setup = await pageSetup(wb);
  for (const attr of ['blackAndWhite="1"', 'draft="1"', 'cellComments="atEnd"', 'errors="dash"']) expect(setup).toContain(attr);
});

it('writes none of them for a sheet that sets none', async () => {
  const wb = await workbookFromFile(file(' cellComments="none" errors="displayed"'), 'report.xlsx');
  expect(wb.activeSheet.printSettings).not.toHaveProperty('blackAndWhite');
  expect(wb.activeSheet.printSettings).not.toHaveProperty('cellComments');
  expect(await pageSetup(wb)).not.toMatch(/blackAndWhite|draft|cellComments|errors/);
});
