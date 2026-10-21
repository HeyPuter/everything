import { expect, it } from 'vitest';
import { calc } from './helpers/calc.js';

// The coupon functions took any two numbers for their dates: COUPNUM(1,1E8,1) walked the schedule back
// over 270,000 years to answer 273791, COUPPCD(1,1E7,4) gave the serial -68 and PRICE over such a
// maturity took seconds to price nonsense, where a date outside the calendar is #NUM!, as in Excel.
const E = { error: '#NUM!' };

it('answers #NUM! for a settlement or maturity outside the calendar', () => {
  expect(calc('COUPNUM(1,1E8,1)')).toEqual(E);
  expect(calc('COUPPCD(1,1E7,4)')).toEqual(E);
  expect(calc('COUPNUM(-1,100,1)')).toEqual(E);
  expect(calc('COUPDAYS(1,2958466,2)')).toEqual(E);
  expect(calc('PRICE(1,1E8,0.05,0.05,100,4)')).toEqual(E);
  expect(calc('YIELD(-5,100,0.05,90,100,1)')).toEqual(E);
  expect(calc('DURATION(1,1E9,0.05,0.05,2)')).toEqual(E);
});

it('keeps dates up to 31 December 9999', () => {
  expect(calc('COUPNUM(1,2958465,4)')).toBe(32400);
  expect(calc('COUPNUM(DATE(2007,1,25),DATE(2008,11,15),2,1)')).toBe(4);
  expect(calc('COUPNCD(DATE(2011,1,25),DATE(2011,11,15),2,1)')).toBe(40678);
});
