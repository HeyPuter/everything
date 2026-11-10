import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

// A percentage whose sign stands after a plain, escaped or quoted space (0.00 %, as French and German sheets
// write it) was written to .ods as a plain number without its sign, so LibreOffice showed 37.5 % as 0.38; the
// words after a sign (0%" of target") were dropped.
it.each([
  ['0.00 %', 0.375, '37.50 %'],
  ['0.00\\ %', 0.375, '37.50 %'],
  ['#,##0.0 %', 12.345, '1,234.5 %'],
  ['0.00" "%', 0.375, '37.50 %'],
  ['0%" of target"', 0.92, '92% of target'],
])('keeps the sign of a percentage formatted %s in .ods', async (code, value, shown) => {
  const wb = new Workbook();
  wb.setCells(wb.activeSheetId, [{ r: 0, c: 0, cell: { v: value, s: { fmt: 'custom', code } } }]);
  expect(wb.getDisplay(wb.activeSheetId, 0, 0)).toBe(shown);
  const bytes = new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer());
  const xml = new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content);
  expect(xml).toMatch(/<number:percentage-style [^>]*><number:number [^>]*\/><number:text>[^<]*%[^<]*<\/number:text><\/number:percentage-style>/);
  const back = await workbookFromFile(bytes, 'percent.ods');
  expect(back.getDisplay(back.activeSheetId, 0, 0)).toBe(shown);
});
