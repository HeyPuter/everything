import { expect, it } from 'vitest';
import { checkValue } from '../src/core/validation.js';

// A Text length rule counts the characters a number reads as in a formula, as LEN does.
it('counts a computed number by the digits it shows, not its binary tail', () => {
  const rule = { type: 'text', min: 3, max: 3 };
  expect(checkValue(rule, 0.1 + 0.2).ok).toBe(true); // "0.3"
  expect(checkValue(rule, 1.1 * 3).ok).toBe(true); // "3.3"
  expect(checkValue(rule, 123).ok).toBe(true);
  expect(checkValue(rule, 1234).ok).toBe(false);
  expect(checkValue({ type: 'text', max: 5 }, 1e21).ok).toBe(true); // "1E+21"
});
