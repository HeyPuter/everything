import { afterEach, expect, it } from 'vitest';
import { accountingCode, isAccountingCode } from '../src/ui/toolbar.js';
import { CURRENCIES, currencyDecimals, formatValue, setLocale, styleToNumFmt } from '../src/core/format.js';

// The Accounting preset's code spelled two decimals for every currency, so a yen cell read ¥1,234.50 where
// the Currency preset, Format cells and the exported code had all come to give it none.
afterEach(() => setLocale('en-US'));

it.each(CURRENCIES.map(([cur]) => cur))('gives %s the decimals its own currency is written with', (cur) => {
  const places = currencyDecimals(cur);
  const shown = formatValue(1234.5, { fmt: 'custom', code: accountingCode(cur) });
  expect(shown).toContain(places ? '1,234.50' : '1,235');
  expect(shown.includes('1,234.50')).toBe(places > 0);
  // The dash a zero shows is padded to the width of those decimals, as Excel writes it.
  expect(accountingCode(cur)).toContain(`"-"${'?'.repeat(places)}_)`);
});

it('agrees with the Currency preset and the exported code on a yen cell', () => {
  setLocale('ja-JP');
  expect(formatValue(1234.5, { fmt: 'currency', cur: 'JPY' })).toBe('￥1,235');
  expect(styleToNumFmt({ fmt: 'currency', cur: 'JPY' })).toBe('"¥"#,##0');
  expect(formatValue(1234.5, { fmt: 'custom', code: accountingCode('JPY') }).trim()).toBe('¥1,235');
  expect(formatValue(0, { fmt: 'custom', code: accountingCode('JPY') }).trim()).toBe('¥-');
});

it('still knows a code saved with the two decimals every currency used to take', () => {
  for (const [cur] of CURRENCIES) expect(isAccountingCode(accountingCode(cur, 2)), cur).toBe(true);
  expect(isAccountingCode('_("¥"* #,##0.00_);_("¥"* (#,##0.00);_("¥"* "-"??_);_(@_)')).toBe(true);
  // Any count of places is the preset, as More and Fewer decimal places and Format Cells now set it.
  expect(isAccountingCode('_("¥"* #,##0.0_);_("¥"* (#,##0.0);_("¥"* "-"?_);_(@_)')).toBe(true);
  expect(isAccountingCode('_("¥"* #,##0.0_);_("¥"* (#,##0.0);_("¥"* "-"??_);_(@_)')).toBe(false);
});
