import { expect, it } from 'vitest';
import { calc } from './helpers/calc.js';

// The incomplete beta's continued fraction multiplies two shapes together in every term. Past a shape of
// about 1E+154 both products overflow, Infinity / Infinity made every term NaN, and the fraction ran on
// towards its limit of 40∛(a + b) terms, 1E+55 of them: =BETA.DIST(0.5,1E+160,0.5,TRUE) froze the tab,
// as did T.INV and T.INV.2T for a vast number of degrees of freedom.
it('answers at once for a vast shape', () => {
  const start = performance.now();
  expect(calc('BETA.DIST(0.5,1E+160,0.5,TRUE)')).toBe(0);
  expect(calc('BETA.DIST(0.999999,1E+160,0.5,TRUE)')).toBe(0);
  expect(calc('BETA.DIST(0.5,1E+154,0.5,TRUE)')).toBe(0);
  expect(calc('BETA.DIST(0.5,0.5,1E+160,TRUE)')).toBe(1);
  expect(typeof calc('T.INV(1E-307,1E+307)')).toBe('number');
  expect(typeof calc('T.INV.2T(1E-307,1E+307)')).toBe('number');
  expect(performance.now() - start).toBeLessThan(5000);
});

it('keeps ordinary beta probabilities', () => {
  expect(calc('BETA.DIST(0.5,2,3,TRUE)')).toBe(0.6875);
  expect(calc('BETA.INV(0.6875,2,3)')).toBeCloseTo(0.5, 14);
  expect(calc('BETA.DIST(0.9,1E6,0.5,TRUE)')).toBe(0);
});
