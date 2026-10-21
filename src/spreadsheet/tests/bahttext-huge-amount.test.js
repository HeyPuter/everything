import { expect, it } from 'vitest';
import { calc } from './helpers/calc.js';

// BAHTTEXT counts the amount in satangs, a hundred to the baht. Past about 1.8E+306 that count overflows
// to Infinity, and reading it off a million at a time never ended: =BAHTTEXT(1E+307) froze the tab.
it('answers #NUM! for an amount past the doubles in satangs', () => {
  expect(calc('BAHTTEXT(1E+307)')).toEqual({ error: '#NUM!' });
  expect(calc('BAHTTEXT(-1E+307)')).toEqual({ error: '#NUM!' });
});

it('still reads out amounts within reach', () => {
  expect(calc('BAHTTEXT(1234.56)')).toBe('หนึ่งพันสองร้อยสามสิบสี่บาทห้าสิบหกสตางค์');
  expect(calc('BAHTTEXT(0)')).toBe('ศูนย์บาทถ้วน');
  expect(calc('LEN(BAHTTEXT(1E+306))')).toBeGreaterThan(1000);
});
