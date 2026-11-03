import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

// Only fractions with a # integer part (# ?/?, # ?/8) were written to .ods. An improper fraction (?/16), one
// with zeros for its integer part (0 ?/?) and a fraction with a unit after it lost their format, so LibreOffice
// showed 1.5 in 0 ?/? as 2 and 1.3125 in ?/16 as 1.3125. ODF says "no integer part" by leaving
// min-integer-digits out, which the reader also took for #, so ?/? reopened as a mixed fraction.
it.each([
  ['?/16', 1.3125, '21/16'],
  ['?/?', 1.5, '3/2'],
  ['??/??', 0.5, ' 1/2 '],
  ['0 ?/?', 1.5, '1 1/2'],
  ['0 ?/?', 0.25, '0 1/4'],
  ['# ?/? "in"', 1.5, '1 1/2 in'],
])('keeps %s through .ods as other programs read it', async (code, value, shown) => {
  const wb = new Workbook();
  wb.setCells(wb.activeSheetId, [{ r: 0, c: 0, cell: { v: value, s: { fmt: 'custom', code } } }]);
  expect(wb.getDisplay(wb.activeSheetId, 0, 0)).toBe(shown);
  const bytes = new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer());
  const xml = new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content);
  expect(xml).toContain('<number:fraction');
  const back = await workbookFromFile(bytes, 'fractions.ods');
  expect(back.getDisplay(back.activeSheetId, 0, 0)).toBe(shown);
});

it('writes an improper fraction without an integer part', async () => {
  const wb = new Workbook();
  wb.setCells(wb.activeSheetId, [{ r: 0, c: 0, cell: { v: 1.5, s: { fmt: 'custom', code: '?/?' } } }]);
  const bytes = new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer());
  const xml = new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content);
  expect(xml).toMatch(/<number:fraction(?![^>]*min-integer-digits)[^>]*number:min-denominator-digits="1"/);
});
