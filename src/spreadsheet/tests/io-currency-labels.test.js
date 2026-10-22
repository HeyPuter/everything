import { expect, it } from 'vitest';
import * as XLSX from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { CURRENCIES, getLocale, setLocale, numFmtToStyle, styleToNumFmt } from '../src/core/format.js';
import { META_SHEET, workbookFromFile, workbookToOds, workbookToXlsx } from '../src/core/io.js';

const labels = {
  USD: '$', EUR: '€', GBP: '£', JPY: '¥', INR: '₹', CNY: 'CN¥', CAD: 'CA$', AUD: 'A$',
  CHF: 'CHF\u00a0', BRL: 'R$', MXN: 'MX$', KRW: '₩', SEK: 'SEK\u00a0', NOK: 'NOK\u00a0',
  PLN: 'PLN\u00a0', TRY: 'TRY\u00a0', DKK: 'DKK\u00a0', CZK: 'CZK\u00a0', RUB: 'RUB\u00a0',
};

it.each(CURRENCIES.map(([cur]) => ({ cur })))(
  'exports the selected $cur currency in XLSX and ODS, including without app metadata', async ({ cur }) => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    const styles = [
      { fmt: 'currency', cur, dec: 2 },
      { fmt: 'currency', cur, dec: 3, group: false },
      { fmt: 'currency', cur, dec: 0 },
    ];
    wb.setCells(id, [1234.5, -1234.5, 0].map((v, c) => ({ r: 0, c, cell: { v, s: styles[c] } })));
    const expected = [`${labels[cur]}1,234.50`, `-${labels[cur]}1234.500`, `${labels[cur]}0`];
    for (const exportFile of [workbookToXlsx, workbookToOds]) {
      const bytes = await (await exportFile(wb)).arrayBuffer();
      const raw = XLSX.read(bytes, { type: 'array', cellNF: true });
      const sheet = raw.Sheets[raw.SheetNames[0]];
      for (const [c, addr] of ['A1', 'B1', 'C1'].entries()) {
        expect(sheet[addr].v).toBe([1234.5, -1234.5, 0][c]);
        expect(XLSX.SSF.format(sheet[addr].z, sheet[addr].v)).toBe(expected[c]);
      }
      const back = await workbookFromFile(bytes, exportFile === workbookToXlsx ? 'currency.xlsx' : 'currency.ods');
      expect(back.getCell(back.activeSheetId, 0, 0).s).toMatchObject(styles[0]);
      // Other spreadsheet apps only see the actual format code, not our sidecar.
      raw.SheetNames = raw.SheetNames.filter((name) => name !== META_SHEET);
      delete raw.Sheets[META_SHEET];
      const external = await workbookFromFile(XLSX.write(raw, { type: 'array', bookType: 'xlsx' }), 'external.xlsx');
      for (let c = 0; c < 3; c++) expect(external.getDisplay(external.activeSheetId, 0, c)).toBe(expected[c]);
    }
  },
);

// The label stays distinct in every regional format: the portable one, or the one the format shows where
// that names the currency alone (US$ in China); the side of the digits it sits on, and the spacing beside it,
// follow the format, as Excel writes #,##0.00 € for a German sheet. Either way the code names its currency.
it('keeps currency labels distinct whatever the current display locale', () => {
  const previous = getLocale();
  try {
    for (const locale of ['en-US', 'en-AU', 'zh-CN', 'de-DE']) {
      setLocale(locale);
      for (const [cur, label] of Object.entries(labels)) {
        const code = styleToNumFmt({ fmt: 'currency', cur, dec: 2 });
        const shown = new Intl.NumberFormat(locale, { style: 'currency', currency: cur }).formatToParts(1).find((p) => p.type === 'currency').value;
        expect([label.trim(), shown.trim()]).toContain(code.replace(/[#,0.]|"/g, '').trim());
        expect(numFmtToStyle(code)).toEqual({ fmt: 'currency', cur, dec: 2 });
      }
    }
    setLocale('zh-CN');
    expect(styleToNumFmt({ fmt: 'currency', cur: 'USD', dec: 2 })).toBe('"US$"#,##0.00');
    setLocale('de-DE');
    expect(styleToNumFmt({ fmt: 'currency', cur: 'EUR', dec: 2 })).toBe('#,##0.00" €"');
    setLocale('en-US');
    expect(styleToNumFmt({ fmt: 'currency', cur: 'EUR', dec: 2 })).toBe('"€"#,##0.00');
  } finally { setLocale(previous); }
});

it.each([
  ['inr', '₹'], ['NZD', 'NZ$'], ['XYZ', 'XYZ\u00a0'],
  ['INVALID', '$'], [null, '$'], [{ toString: null }, '$'],
])('handles currency metadata %j with an accurate label or the default', (cur, label) => {
  expect(styleToNumFmt({ fmt: 'currency', cur, dec: 2 })).toBe(`"${label}"#,##0.00`);
});

it.each(['"CHF"0.00', '"kr"0.00', '"₹"0.00;[Red]-"₹"0.00', `"CA$"0.${'0'.repeat(21)}`])(
  'preserves currency format %s when a named style cannot express it exactly', (code) => {
    expect(numFmtToStyle(code)).toEqual({ fmt: 'custom', code });
  },
);
