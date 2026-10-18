import { expect, it } from 'vitest';
import { calc } from './helpers/calc.js';

// "MD" counts from the start day placed in the month before the end date, letting a day that month
// lacks roll over into the next: the negative and zero results Excel documents for the unit.
it.each([
  ['DATE(2015,1,31),DATE(2015,3,1)', -2],
  ['DATE(2015,1,30),DATE(2015,3,1)', -1],
  ['DATE(2015,1,29),DATE(2015,3,1)', 0],
  ['DATE(2015,1,28),DATE(2015,3,1)', 1],
  ['DATE(2012,1,31),DATE(2012,3,1)', -1],
  ['DATE(2024,3,31),DATE(2024,5,1)', 0],
])('DATEDIF(%s,"MD") is %s', (dates, expected) => {
  expect(calc(`DATEDIF(${dates},"MD")`)).toBe(expected);
});

it('keeps the ordinary day counts of "MD"', () => {
  expect(calc('DATEDIF(DATE(2020,1,15),DATE(2024,3,10),"MD")')).toBe(24);
  expect(calc('DATEDIF(DATE(2024,1,31),DATE(2024,2,29),"MD")')).toBe(29);
  expect(calc('DATEDIF(DATE(2024,3,31),DATE(2024,4,30),"MD")')).toBe(30);
  expect(calc('DATEDIF(DATE(2023,12,20),DATE(2024,1,5),"MD")')).toBe(16);
  expect(calc('DATEDIF(DATE(2024,1,5),DATE(2024,1,20),"MD")')).toBe(15);
});
