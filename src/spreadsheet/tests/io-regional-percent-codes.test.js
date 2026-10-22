import { afterEach, expect, it } from 'vitest';
import * as XLSX from '../src/vendor/xlsx.mjs';
import { formatValue, numFmtToStyle, setLocale, styleToNumFmt } from '../src/core/format.js';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds, workbookToXlsx } from '../src/core/io.js';

// The grid writes a percentage as the regional format does, 12,3 % with a no-break space in France and
// Germany and %12,3 in Turkey, but the Percent format's code was 0.0% everywhere, so a saved file showed
// 12,3% in Excel, and a copy to another app the same. The code now places the sign, and the space beside
// it, as the format does; it reads back as the Percent format, and an .ods keeps it a percentage.
afterEach(() => setLocale('en-US'));
const style = { fmt: 'percent', dec: 1 };
const raw = async (blob) => {
  const book = XLSX.read(new Uint8Array(await blob.arrayBuffer()), { type: 'array', cellNF: true });
  return book.Sheets[book.SheetNames[0]].A1;
};

it.each(['fr-FR', 'de-DE', 'es-ES', 'sv-SE', 'tr-TR', 'en-US', 'nl-NL'])('saves the Percent format as the grid shows it under %s', async (loc) => {
  setLocale(loc);
  const code = styleToNumFmt(style);
  expect(formatValue(0.123, { fmt: 'custom', code })).toBe(formatValue(0.123, style));
  expect(numFmtToStyle(code)).toEqual({ fmt: 'percent', dec: 1 });
  const wb = new Workbook();
  wb.setCells(wb.activeSheetId, [{ r: 0, c: 0, cell: { v: 0.123, s: style } }]);
  for (const save of [workbookToXlsx, workbookToOds]) {
    const cell = await raw(await save(wb));
    // What another program shows through the code it reads, the % scaling the value in both files.
    expect(formatValue(cell.v, { fmt: 'custom', code: cell.z }), `${loc} ${save.name}`).toBe(formatValue(0.123, style));
  }
});

it('writes the space and the sign first as the regional formats do', () => {
  setLocale('fr-FR');
  expect(styleToNumFmt(style)).toBe('#,##0.0"\u00a0"%');
  setLocale('de-DE');
  expect(styleToNumFmt(style)).toBe('#,##0.0"\u00a0"%');
  setLocale('tr-TR');
  expect(styleToNumFmt(style)).toBe('%#,##0.0');
  setLocale('en-US');
  expect(styleToNumFmt(style)).toBe('#,##0.0%');
  // A plain space typed into a custom code stays that custom code.
  expect(numFmtToStyle('0.0 %')).toEqual({ fmt: 'custom', code: '0.0 %' });
});

it('reads a LibreOffice percentage with a space before its sign as a percentage', async () => {
  setLocale('de-DE');
  const wb = new Workbook();
  wb.setCells(wb.activeSheetId, [{ r: 0, c: 0, cell: { v: 0.5, s: { fmt: 'percent', dec: 0 } } }]);
  const back = await workbookFromFile(new Uint8Array(await (await workbookToOds(wb)).arrayBuffer()), 'saved.ods');
  expect(back.getDisplay(back.activeSheetId, 0, 0)).toBe(formatValue(0.5, { fmt: 'percent', dec: 0 }));
});
