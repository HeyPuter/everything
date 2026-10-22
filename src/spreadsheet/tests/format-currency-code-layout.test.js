import { afterEach, expect, it } from 'vitest';
import { CURRENCIES, LOCALES, currencyAffixes, formatValue, numFmtToStyle, setLocale, styleToNumFmt } from '../src/core/format.js';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

// The Currency format's code always put the label in front of the digits, so a German cell reading
// 1.234,50 € exported and copied as "€"#,##0.00 and opened in Excel as €1.234,50. The label now takes
// the side of the digits, and the spacing, that the regional format writes it with. The label is the one
// the format shows where that names the currency alone ($US in France, ₺ in Turkey), else the portable,
// distinct one, so the code still names the same currency anywhere.
const NBSP = ' ';
afterEach(() => setLocale('en-US'));

it('writes the currency label where the regional format puts it', () => {
  setLocale('de-DE');
  expect(formatValue(1234.5, { fmt: 'currency', cur: 'EUR' })).toBe(`1.234,50${NBSP}€`);
  expect(styleToNumFmt({ fmt: 'currency', cur: 'EUR' })).toBe(`#,##0.00"${NBSP}€"`);
  expect(styleToNumFmt({ fmt: 'currency', cur: 'JPY' })).toBe(`#,##0"${NBSP}¥"`);
  setLocale('fr-FR');
  expect(formatValue(1234.5, { fmt: 'currency', cur: 'USD', dec: 2 })).toBe(`1\u202f234,50${NBSP}$US`);
  expect(styleToNumFmt({ fmt: 'currency', cur: 'USD', dec: 2 })).toBe(`#,##0.00"${NBSP}$US"`);
  // The regional formats that lead with the label keep the code they always had.
  setLocale('en-US');
  expect(styleToNumFmt({ fmt: 'currency', cur: 'USD', dec: 2 })).toBe('"$"#,##0.00');
  expect(styleToNumFmt({ fmt: 'currency', cur: 'SEK', dec: 2 })).toBe(`"SEK${NBSP}"#,##0.00`);
  setLocale('ja-JP');
  expect(styleToNumFmt({ fmt: 'currency', cur: 'JPY' })).toBe('"¥"#,##0');
});

it('writes the label the regional format shows where it names the currency alone, else the portable one', () => {
  const labels = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', INR: '₹', CNY: 'CN¥', CAD: 'CA$', AUD: 'A$', CHF: 'CHF', BRL: 'R$', MXN: 'MX$', KRW: '₩', SEK: 'SEK', NOK: 'NOK', PLN: 'PLN', TRY: 'TRY', DKK: 'DKK', CZK: 'CZK', RUB: 'RUB' };
  for (const [locale] of LOCALES) {
    setLocale(locale);
    for (const [cur] of CURRENCIES) {
      const code = styleToNumFmt({ fmt: 'currency', cur, dec: 2 });
      const label = code.match(/"([^"]*)"/)[1].trim();
      const shown = formatValue(1, { fmt: 'currency', cur, dec: 0 }).replace(/[\d\s]/g, '');
      expect([labels[cur], shown], `${locale} ${cur}`).toContain(label);
    }
  }
  // A sign several currencies share keeps the portable label: kr is the krona, the krone and the Danish krone.
  setLocale('sv-SE');
  expect(styleToNumFmt({ fmt: 'currency', cur: 'SEK', dec: 2 })).toBe(`#,##0.00"${NBSP}SEK"`);
});

it('reads a code back as the same Currency format whichever side its label is on', () => {
  for (const [locale] of LOCALES) {
    setLocale(locale);
    for (const [cur] of CURRENCIES) {
      for (const style of [{ fmt: 'currency', cur }, { fmt: 'currency', cur, dec: 5 }, { fmt: 'currency', cur, dec: 0, group: false }]) {
        const code = styleToNumFmt(style);
        const back = numFmtToStyle(code);
        expect(back).toMatchObject({ fmt: 'currency', cur });
        expect(styleToNumFmt(back)).toBe(code);
        expect(formatValue(1234.5, back)).toBe(formatValue(1234.5, style));
      }
    }
  }
  // Codes written before, with the label always in front, still name their currency.
  setLocale('en-US');
  expect(numFmtToStyle('"€"#,##0.00')).toEqual({ fmt: 'currency', cur: 'EUR', dec: 2 });
  expect(numFmtToStyle(`"CHF${NBSP}"#,##0.00`)).toEqual({ fmt: 'currency', cur: 'CHF', dec: 2 });
  // A label no currency on offer answers to stays a custom code, on either side.
  expect(numFmtToStyle('"kr"0.00')).toEqual({ fmt: 'custom', code: '"kr"0.00' });
  expect(numFmtToStyle('0.00"kr"')).toEqual({ fmt: 'custom', code: '0.00"kr"' });
});

// currencyAffixes is what every code for an amount in a currency is built from — the Currency format here,
// the Accounting preset, and Format cells' negative-style codes — so they all lay a cell out the same way.
// A section quoted from the affixes must come out as styleToNumFmt writes it, or two codes for the same cell
// would disagree.
const section = (cur, dec) => {
  const { prefix, suffix } = currencyAffixes(cur);
  return `${prefix ? `"${prefix}"` : ''}#,##0${dec ? `.${'0'.repeat(dec)}` : ''}${suffix ? `"${suffix}"` : ''}`;
};

it('builds the same section every currency code is built from', () => {
  for (const [locale] of LOCALES) {
    setLocale(locale);
    for (const [cur] of CURRENCIES) {
      for (const dec of [0, 2, 5]) expect(section(cur, dec), `${locale} ${cur} ${dec}`).toBe(styleToNumFmt({ fmt: 'currency', cur, dec }));
      // One affix or the other, never both, and the pair is shared and frozen.
      const affixes = currencyAffixes(cur);
      expect(!!affixes.prefix !== !!affixes.suffix, `${locale} ${cur}`).toBe(true);
      expect(Object.isFrozen(affixes)).toBe(true);
    }
  }
});

it('spaces the label the way the regional format does, which is rarely an ordinary space', () => {
  // A plain U+0020 among the affixes would be a hard-coded space standing in for the format's own
  // no-break one, and would look identical in a log; there is never one.
  for (const [locale] of LOCALES) {
    setLocale(locale);
    for (const [cur] of CURRENCIES) {
      const { prefix, suffix } = currencyAffixes(cur);
      expect(`${prefix}${suffix}`, `${locale} ${cur}`).not.toContain(' ');
    }
  }
  setLocale('de-DE');
  expect(currencyAffixes('EUR')).toEqual({ prefix: '', suffix: `${NBSP}€` });
  setLocale('nl-NL');
  expect(currencyAffixes('EUR')).toEqual({ prefix: `€${NBSP}`, suffix: '' });
});

it('strips the label\'s own spacing before the format\'s side is decided', () => {
  // currencyFormatLabel bakes in the space a prefix needs ("NOK "), which flipped whole to the other side
  // would read 1.234,50 NOK with a stray space at the end.
  setLocale('en-US');
  expect(currencyAffixes('NOK')).toEqual({ prefix: `NOK${NBSP}`, suffix: '' });
  setLocale('nb-NO');
  expect(currencyAffixes('NOK')).toEqual({ prefix: '', suffix: `${NBSP}NOK` });
  expect(section('NOK', 2)).toBe(`#,##0.00"${NBSP}NOK"`);
  // A label of letters keeps a separator even where the format writes its own symbol tight against the digits;
  // the format's own sign, where it names the currency alone, sits tight as the format writes it.
  setLocale('en-US');
  expect(currencyAffixes('TRY')).toEqual({ prefix: `TRY${NBSP}`, suffix: '' });
  setLocale('tr-TR');
  expect(currencyAffixes('TRY')).toEqual({ prefix: '₺', suffix: '' });
  expect(currencyAffixes('USD')).toEqual({ prefix: '$', suffix: '' });
});

it('carries the German layout through a saved file', async () => {
  setLocale('de-DE');
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: 1234.5, s: { fmt: 'currency', cur: 'EUR' } } }]);
  expect(wb.getDisplay(id, 0, 0)).toBe(`1.234,50${NBSP}€`);
  const back = await workbookFromFile(await workbookToXlsx(wb), 'euro.xlsx');
  expect(back.getCell(back.activeSheetId, 0, 0).s).toMatchObject({ fmt: 'currency', cur: 'EUR' });
  expect(back.getDisplay(back.activeSheetId, 0, 0)).toBe(`1.234,50${NBSP}€`);
});
