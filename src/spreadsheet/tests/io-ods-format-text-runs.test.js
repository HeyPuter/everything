import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

const content = (bytes) => new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content);

// The ODS writer kept only one quoted literal after the digits, directly or after plain spaces.
// Excel's own euro format escapes its space (#,##0.00\ "€", and [$€-407] the same way), and units
// are often escaped or split (0.00\ \k\g, 0.00 "x" "y"): all of it was dropped, so LibreOffice showed
// 1,234.50 with no currency or unit, and a leading "€ " lost its space.
it.each([
  ['#,##0.00\\ "€"', ' €', /€/],
  ['#,##0.00\\ [$€-407]', ' €', /€/],
  ['0.00\\ \\k\\g', ' kg', /^1234\.50 kg$/],
  ['0.00 "x" "y"', ' x y', /^1234\.50 x y$/],
  ['0.0\\%', '%', /^1234\.5%$/],
])('writes the text after the digits of %s', async (code, text, shown) => {
  const wb = new Workbook();
  wb.setCells(wb.activeSheetId, [{ r: 0, c: 0, cell: { v: 1234.5, s: { fmt: 'custom', code } } }]);
  const bytes = new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer());
  expect(content(bytes)).toMatch(new RegExp(`</number:number><number:text>${text.replace(/[%]/g, '\\$&')}</number:text>`));
  const back = await workbookFromFile(bytes, 'units.ods');
  expect(back.getDisplay(back.activeSheetId, 0, 0)).toMatch(shown);
});

it('writes the space between a leading literal and the digits', async () => {
  const wb = new Workbook();
  wb.setCells(wb.activeSheetId, [
    { r: 0, c: 0, cell: { v: 1234.5, s: { fmt: 'custom', code: '"€" #,##0.00' } } },
    { r: 1, c: 0, cell: { v: 1234.5, s: { fmt: 'custom', code: '\\(0.00\\)' } } },
  ]);
  const xml = content(new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer()));
  expect(xml).toContain('<number:text>€ </number:text><number:number');
  expect(xml).toMatch(/<number:text>\(<\/number:text><number:number[^>]*><\/number:number><number:text>\)<\/number:text>/);
});
