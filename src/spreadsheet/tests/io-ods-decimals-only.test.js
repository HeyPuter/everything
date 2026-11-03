import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

// A number format with no integer digit (.00) was written to .ods with its decimals taken for the integer
// part, as 00, so LibreOffice showed 0.375 as 00 and 1234.5 as 1235.
it.each([
  ['.00', [0.375, 1234.5, -5], ['.38', '1234.50', '-5.00']],
  ['.0#', [0.375, 1234.5], ['.38', '1234.5']],
  ['.00" m"', [0.375], ['.38 m']],
])('keeps the decimals of %s through .ods', async (code, values, shown) => {
  const wb = new Workbook();
  wb.setCells(wb.activeSheetId, values.map((v, c) => ({ r: 0, c, cell: { v, s: { fmt: 'custom', code } } })));
  expect(values.map((v, c) => wb.getDisplay(wb.activeSheetId, 0, c))).toEqual(shown);
  const back = await workbookFromFile(await (await workbookToOds(wb, { settings: false })).arrayBuffer(), 'decimals.ods');
  expect(values.map((v, c) => back.getDisplay(back.activeSheetId, 0, c))).toEqual(shown);
});
