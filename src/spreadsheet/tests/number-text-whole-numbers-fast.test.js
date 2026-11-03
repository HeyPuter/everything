import { afterEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { formatNumberText, setLocale } from '../src/core/format.js';

afterEach(() => { vi.restoreAllMocks(); setLocale('en-US'); });

// Every number a formula turned into text (TEXTJOIN, CONCAT, LEN, A1&"") went through the full
// fifteen-digit conversion, about a microsecond each: 2,000 rows of LEN(TEXTJOIN(",",TRUE,$A$1:$A$2000))
// over a column of counts took three seconds. A whole number of up to fifteen digits is now written
// as its digits straight away.
it('writes whole numbers as their digits without the general conversion', () => {
  const spy = vi.spyOn(Number.prototype, 'toExponential');
  const wb = new Workbook(), id = wb.activeSheetId;
  const entries = [];
  for (let r = 0; r < 500; r++) entries.push({ r, c: 0, cell: { v: r % 2 ? r * 1234567 : -r } });
  entries.push({ r: 0, c: 1, cell: { f: 'LEN(TEXTJOIN(",",TRUE,A1:A500))' } });
  wb.setCells(id, entries);
  expect(wb.getValue(id, 0, 1)).toBeGreaterThan(500);
  expect(spy).not.toHaveBeenCalled();
});

it.each([
  [0, '0'], [-0, '0'], [7, '7'], [-42, '-42'], [999999999999999, '999999999999999'],
  [-999999999999999, '-999999999999999'], [1e15, '1000000000000000'], [2 ** 53, '9007199254740990'],
  [1e19, '10000000000000000000'], [1e20, '1E+20'], [0.5, '0.5'],
])('writes %s as %s', (n, text) => {
  expect(formatNumberText(n)).toBe(text);
});

it('writes a whole number the same in a region with a decimal comma', () => {
  setLocale('de-DE');
  expect(formatNumberText(1234567)).toBe('1234567');
  expect(formatNumberText(1.5)).toBe('1,5');
});
