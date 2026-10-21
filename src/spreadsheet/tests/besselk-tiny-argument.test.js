import { expect, it } from 'vitest';
import { calc } from './helpers/calc.js';

// BESSELK below x = 20 integrates out to where its integrand has fallen e^-40, acosh(1 + 42/x). Below
// about 2E-307 that 42/x overflows to Infinity, and =BESSELK(1E-307,0) stepped towards it for ever,
// freezing the tab. There the leading terms, -ln(x/2) - γ and 1/x, are the values to rounding.
it('answers at once for an argument too small for the integral to end', () => {
  const start = performance.now();
  expect(calc('BESSELK(1E-307,0)')).toBeCloseTo(-(Math.log(1e-307 / 2) + 0.5772156649015329), 10);
  expect(calc('BESSELK(2E-307,0)')).toBeCloseTo(-(Math.log(2e-307 / 2) + 0.5772156649015329), 10);
  expect(calc('BESSELK(1E-307,1)') / 1e307).toBeCloseTo(1, 12);
  expect(calc('BESSELK(1E-307,2)')).toEqual({ error: '#NUM!' }); // 2/x² is past the doubles
  expect(performance.now() - start).toBeLessThan(3000);
});

it('agrees with the integral where both apply', () => {
  expect(calc('BESSELK(1.1E-300,0)')).toBeCloseTo(-(Math.log(1.1e-300 / 2) + 0.5772156649015329), 10);
  expect(calc('BESSELK(1.5,1)')).toBeCloseTo(0.27738780045684386, 14);
});
