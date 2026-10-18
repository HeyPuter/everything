import { afterEach, expect, it } from 'vitest';
import { parseInput, setLocale, ymdToSerial } from '../src/core/format.js';

afterEach(() => setLocale('en-US'));

// Where dates are written with dots, the quick way to type a date of this year is the day and month each
// followed by its full stop ("24.12."), as German Excel reads it. That entry stayed text; only "24.12" was a date.
it.each([['de-DE', '24.12.'], ['de-DE', '1.3.'], ['cs-CZ', '24. 12.'], ['pl-PL', '24.12.'], ['fi-FI', '24.12.']])('reads %s %s as a date of this year', (loc, text) => {
  setLocale(loc);
  const year = new Date().getFullYear();
  const [d, m] = text.split('.').map(Number);
  expect(parseInput(text)).toMatchObject({ v: ymdToSerial(year, m, d), fmt: 'date' });
});

it('keeps other dotted text as text', () => {
  setLocale('de-DE');
  for (const text of ['32.1.', '31.2.', '24.12.2024.', '24..12.', '1.2.3.']) expect(parseInput(text).v).toBe(text);
  setLocale('en-US');
  expect(parseInput('24.12.').v).toBe('24.12.');
});
