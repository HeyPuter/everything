import { expect, it } from 'vitest';
import { calc } from './helpers/calc.js';

// VALUE converts text that reads as a number; a logical value is not such text and is #VALUE!
// (N or -- turn TRUE into 1).
it('refuses a logical value', () => {
  expect(calc('VALUE(TRUE)')).toEqual({ error: '#VALUE!' });
  expect(calc('VALUE(A1)', { A1: 'FALSE' })).toEqual({ error: '#VALUE!' });
  expect(calc('VALUE(1=1)')).toEqual({ error: '#VALUE!' });
});

it('keeps converting numbers, numeric text and blanks', () => {
  expect(calc('VALUE("1,234.5")')).toBe(1234.5);
  expect(calc('VALUE(7)')).toBe(7);
  expect(calc('VALUE(A1)', { A1: '12%' })).toBe(0.12);
  expect(calc('VALUE(B9)')).toBe(0);
  expect(calc('N(TRUE)+--TRUE')).toBe(2);
});
