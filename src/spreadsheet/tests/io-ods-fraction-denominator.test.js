import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

// Excel's "Up to two digits" fraction (# ??/??, built-in format 13) was written to .ods with the numerator's
// width alone. A reader takes the denominator's from min-denominator-digits, so the format came back as
// # ??/? and 1241.5678 showed as 1241  4/7 instead of 1241 46/81, in LibreOffice and here.
it.each([
  ['# ??/??', 1241.5678, '1241 46/81'],
  ['# ???/???', 0.3333, '    1/3  '],
  ['# ?/?', 1.75, '1 3/4'],
])('keeps the denominator width of %s through .ods', async (code, value, shown) => {
  const wb = new Workbook();
  wb.setCells(wb.activeSheetId, [{ r: 0, c: 0, cell: { v: value, s: { fmt: 'custom', code } } }]);
  const bytes = new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer());
  const xml = new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content);
  expect(xml).toContain(`number:min-denominator-digits="${code.split('/')[1].length}"`);
  const back = await workbookFromFile(bytes, 'fractions.ods');
  expect(back.getDisplay(back.activeSheetId, 0, 0)).toBe(wb.getDisplay(wb.activeSheetId, 0, 0));
  expect(back.getDisplay(back.activeSheetId, 0, 0).trim()).toBe(shown.trim());
});
