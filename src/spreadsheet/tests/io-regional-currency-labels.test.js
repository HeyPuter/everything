import { afterEach, expect, it } from 'vitest';
import { formatValue, numFmtToStyle, setLocale, styleToNumFmt } from '../src/core/format.js';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import * as XLSX from '../src/vendor/xlsx.mjs';

// The grid writes a foreign currency with the label the regional format gives it (1 234,50 $US in France,
// US$1,234.50 in Britain, 1.234,50 USD in Italy), but the Currency format's code always carried the
// American label, so the saved file showed 1 234,50 $ in Excel. The code now carries the label the grid
// shows wherever that names the currency alone, and reads back as the same Currency format; a sign several
// currencies share (kr in Sweden) keeps the portable label, which names the currency wherever it is opened.
afterEach(() => setLocale('en-US'));

it.each([['fr-FR', 'USD'], ['fr-FR', 'CAD'], ['en-GB', 'USD'], ['it-IT', 'USD'], ['pl-PL', 'CAD'], ['zh-CN', 'USD'], ['tr-TR', 'TRY'], ['nl-NL', 'USD']])(
  'saves the label the grid shows under %s for %s', async (loc, cur) => {
    setLocale(loc);
    const style = { fmt: 'currency', cur, dec: 2 };
    const code = styleToNumFmt(style);
    expect(formatValue(1234.5, { fmt: 'custom', code })).toBe(formatValue(1234.5, style));
    expect(numFmtToStyle(code)).toEqual(style);
    const wb = new Workbook();
    wb.setCells(wb.activeSheetId, [{ r: 0, c: 0, cell: { v: 1234.5, s: style } }]);
    const bytes = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
    const cell = XLSX.read(bytes, { type: 'array', cellNF: true }).Sheets.Sheet1.A1;
    expect(formatValue(cell.v, { fmt: 'custom', code: cell.z })).toBe(formatValue(1234.5, style));
    const back = await workbookFromFile(bytes, 'saved.xlsx');
    expect(back.getCell(back.activeSheetId, 0, 0).s).toMatchObject(style);
  });

it('keeps the portable label for a sign several currencies share, and reads a typed ISO code as written', () => {
  setLocale('sv-SE');
  expect(styleToNumFmt({ fmt: 'currency', cur: 'SEK', dec: 2 })).toBe('#,##0.00" SEK"');
  setLocale('fr-FR');
  expect(styleToNumFmt({ fmt: 'currency', cur: 'USD', dec: 2 })).toBe('#,##0.00" $US"');
  setLocale('en-US');
  expect(numFmtToStyle('"USD "0')).toEqual({ fmt: 'custom', code: '"USD "0' });
  expect(numFmtToStyle('#,##0.00" $US"')).toEqual({ fmt: 'currency', cur: 'USD', dec: 2 });
});
