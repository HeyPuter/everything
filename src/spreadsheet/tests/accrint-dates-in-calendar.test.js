import { expect, it } from 'vitest';
import { calc } from './helpers/calc.js';

// ACCRINT took any numbers for its dates: under the actual/actual basis a settlement of 1E8 laid out
// quasi-coupon periods for nine seconds to answer 1368953.48, and a first interest date of 1E15 gave 0,
// where a date past 31 December 9999 is #NUM!, as for every other date argument.
const E = { error: '#NUM!' };

it('answers #NUM! at once for a date outside the calendar', () => {
  const start = performance.now();
  expect(calc('ACCRINT(1,2,1E8,0.05,100,4,1)')).toEqual(E);
  expect(calc('ACCRINT(1,1E15,2,0.05,100,4,1)')).toEqual(E);
  expect(calc('ACCRINT(1,1E9,2958465,0.05,100,4,1)')).toEqual(E);
  expect(calc('ACCRINT(3E6,3E6,3E6+1,0.05,100,4,0)')).toEqual(E);
  expect(performance.now() - start).toBeLessThan(3000);
});

it('keeps the interest accrued between dates of the calendar', () => {
  expect(calc('ACCRINT(DATE(2008,3,1),DATE(2008,8,31),DATE(2008,5,1),0.1,1000,2,0)')).toBeCloseTo(16.666666666666664, 12);
  expect(calc('ACCRINT("2008-03-01","2008-08-31","2008-05-01",0.1,1000,2,0)')).toBeCloseTo(16.666666666666664, 12);
  expect(calc('ACCRINT(-1,2,1000,0.05,100,4,1)')).toEqual(E);
});
