import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

// A text format with words around the text ("Re: "@, @" kg") was written to .ods as a number style holding the
// leading words alone, so LibreOffice showed "Re: " in place of the text and dropped the trailing words.
it.each([
  ['"Re: "@', 'Re: memo'],
  ['@" kg"', 'memo kg'],
  ['"x"@"y"', 'xmemoy'],
])('keeps the text of a cell formatted %s in .ods', async (code, shown) => {
  const wb = new Workbook();
  wb.setCells(wb.activeSheetId, [{ r: 0, c: 0, cell: { v: 'memo', s: { fmt: 'custom', code } } }]);
  expect(wb.getDisplay(wb.activeSheetId, 0, 0)).toBe(shown);
  const bytes = new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer());
  const xml = new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content);
  expect(xml).toMatch(/<number:text-style [^>]*>(?:<number:text>[^<]*<\/number:text>)?<number:text-content\/>/);
  const back = await workbookFromFile(bytes, 'text.ods');
  expect(back.getDisplay(back.activeSheetId, 0, 0)).toBe(shown);
});
