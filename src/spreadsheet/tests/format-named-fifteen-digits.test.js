import { afterEach, expect, it } from 'vitest';
import { formatValue, setLocale } from '../src/core/format.js';
import { formatWithCode } from '../src/core/numfmt.js';

afterEach(() => setLocale('en-US'));

// Number, Currency and Percent wrote every digit of the binary value, so 0.1+0.2 at twenty places read
// 0.30000000000000004000 and =2^60 read 1,152,921,504,606,846,976, where Excel (and the same format as a
// custom code) shows fifteen significant digits and then zeros.
it('shows fifteen significant digits under the named number formats', () => {
  expect(formatValue(0.1 + 0.2, { fmt: 'number', dec: 20 })).toBe('0.30000000000000000000');
  expect(formatValue(2 ** 60, { fmt: 'number', dec: 0 })).toBe('1,152,921,504,606,850,000');
  expect(formatValue(2 ** 60, { fmt: 'number', dec: 0 })).toBe(formatWithCode(2 ** 60, '#,##0'));
  expect(formatValue(123456789012345678, { fmt: 'currency' })).toBe('$123,456,789,012,346,000.00');
  expect(formatValue(2 ** 60, { fmt: 'percent', dec: 0 })).toBe('115,292,150,460,685,000,000%');
  expect(formatValue(0.1 + 0.2, { fmt: 'percent', dec: 17 })).toBe('30.00000000000000000%');
  setLocale('de-DE');
  expect(formatValue(0.1 + 0.2, { fmt: 'number', dec: 18 })).toBe('0,300000000000000000');
});

it('keeps ordinary rounding and the largest numbers', () => {
  expect(formatValue(1.005, { fmt: 'number', dec: 2 })).toBe('1.01');
  expect(formatValue(-1234.5, { fmt: 'currency', cur: 'EUR' })).toBe('-€1,234.50');
  expect(formatValue(0.125, { fmt: 'percent', dec: 1 })).toBe('12.5%');
  expect(formatValue(Number.MAX_VALUE, { fmt: 'number', dec: 0 })).toMatch(/^179,769,313,486,231,570(,000)+$/);
});
