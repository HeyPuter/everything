import { afterEach, expect, it } from 'vitest';
import { parseInput, setLocale } from '../src/core/format.js';

afterEach(() => setLocale('en-US'));

// A number in parentheses is negative, (5) and ($5) alike, but a percentage in them, (5%) or the (12.50%)
// a pasted financial report shows, stayed text. It is now the negative percentage, as Excel reads it.
it('reads a percentage in parentheses as negative', () => {
  expect(parseInput('(5%)')).toMatchObject({ v: -0.05, fmt: 'percent' });
  expect(parseInput('(12.50%)')).toMatchObject({ v: -0.125, fmt: 'percent' });
  expect(parseInput('(0%)')).toMatchObject({ v: 0, fmt: 'percent' });
  setLocale('de-DE');
  expect(parseInput('(5,5 %)')).toMatchObject({ v: -0.055, fmt: 'percent' });
});

it('keeps a signed or misplaced percentage in parentheses as text', () => {
  for (const text of ['(-5%)', '(+5%)', '(5)%', '(abc%)', '(%)']) expect(parseInput(text).v).toBe(text);
});
