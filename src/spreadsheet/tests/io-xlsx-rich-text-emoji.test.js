import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

// A cell with mixed formatting wrote each emoji as two escaped halves (_xD83D__xDE00_), where a plain
// cell writes the character itself. Readers that decode such escapes one code unit at a time (openpyxl,
// and with it pandas) handed back two broken characters instead of the emoji. Only a lone half, which
// XML cannot hold, is escaped now.
it('writes emoji in rich text as characters and escapes only lone surrogates', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const text = 'Launch 🚀 done 😀', broken = 'half \ud83d end';
  wb.setCells(id, [
    { r: 0, c: 0, cell: { v: text, richText: [{ text: 'Launch', s: { bold: true } }, { text: ' 🚀 done 😀' }] } },
    { r: 1, c: 0, cell: { v: broken, richText: [{ text: 'half', s: { italic: true } }, { text: ' \ud83d end' }] } },
  ]);
  const data = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
  const zip = X.CFB.read(data, { type: 'array' });
  const xml = new TextDecoder().decode(X.CFB.find(zip, '/xl/worksheets/sheet1.xml').content);
  const first = xml.match(/<c r="A1"[\s\S]*?<\/c>/)[0], second = xml.match(/<c r="A2"[\s\S]*?<\/c>/)[0];
  expect(first).toContain('<b');
  expect(first).toContain(' 🚀 done 😀');
  expect(first).not.toMatch(/_xD8|_xDE/i);
  expect(second).toContain('_xD83D_');
  const back = await workbookFromFile(data, 'emoji.xlsx');
  expect(back.getValue(back.activeSheetId, 0, 0)).toBe(text);
  expect(back.getCell(back.activeSheetId, 0, 0).richText.map((run) => run.text).join('')).toBe(text);
  expect(back.getValue(back.activeSheetId, 1, 0)).toBe(broken);
});
