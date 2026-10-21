import { expect, it } from 'vitest';
import { calc } from './helpers/calc.js';

// BINOM.INV bisects the counts, halving lo + hi. Past 2^53 that sum rounds up, the middle lands on hi
// and the search never narrows: =BINOM.INV(2^53,1,1) or =BINOM.INV(2^53,0.999,0.5) froze the tab.
it('answers for a count of trials near the largest whole numbers', () => {
  const start = performance.now();
  expect(calc('BINOM.INV(2^53,1,1)')).toBe(2 ** 53);
  expect(calc('CRITBINOM(2^53,1,0.5)')).toBe(2 ** 53);
  expect(Math.abs(calc('BINOM.INV(2^53,0.999,0.5)') / (0.999 * 2 ** 53) - 1)).toBeLessThan(1e-9);
  expect(calc('BINOM.INV(1E16,0.5,0.5)')).toBe(5e15);
  expect(performance.now() - start).toBeLessThan(5000);
});

it('keeps the answers for ordinary counts', () => {
  expect(calc('BINOM.INV(6,0.5,0.75)')).toBe(4);
  expect(calc('CRITBINOM(10,0.3,0.5)')).toBe(3);
  expect(calc('BINOM.INV(10,0.3,0)')).toBe(0);
  expect(calc('BINOM.INV(10,0.3,1)')).toBe(10);
  expect(calc('BINOM.INV(1E12,0.5,0.5)')).toBe(5e11);
  expect(calc('BINOM.INV(2^53,0.5,0.5)')).toBe(2 ** 52);
});
