import { expect, it } from 'vitest';
import { calc } from './helpers/calc.js';

// Settlement, maturity and issue are whole days: two times of one day are the same date, so a
// security that settles and matures on it is #NUM!, as one with settlement after maturity is.
it.each([
  'PRICEDISC(45292.2,45292.9,0.05,100)',
  'RECEIVED(45292.2,45292.9,97,0.05)',
  'DISC(45292.2,45292.9,97,100)',
  'YIELDDISC(45292.2,45292.9,97,100)',
  'INTRATE(45292.2,45292.9,97,100)',
  'TBILLPRICE(45292.2,45292.9,0.05)',
  'TBILLYIELD(45292.2,45292.9,97)',
  'TBILLEQ(45292.2,45292.9,0.05)',
  'PRICEMAT(45292.2,45292.9,45000,0.05,0.05)',
  'YIELDMAT(45292.2,45292.9,45000,0.05,99)',
  'PRICEMAT(45292.2,45400,45292.1,0.05,0.05)',
  'YIELDMAT(45292.2,45400,45292.1,0.05,99)',
  'ACCRINTM(45292.2,45292.9,0.05,1000)',
  'ACCRINT(45292.2,45400,45292.9,0.05,1000,2)',
])('%s is #NUM! for one day', (formula) => {
  expect(calc(formula)).toEqual({ error: '#NUM!' });
});

it('still prices across days whatever the times', () => {
  expect(calc('PRICEDISC(45292.9,45293.1,0.05,100)')).toBeCloseTo(calc('PRICEDISC(45292,45293,0.05,100)'), 12);
  expect(calc('TBILLPRICE(45292.9,45293.1,0.05)')).toBeCloseTo(calc('TBILLPRICE(45292,45293,0.05)'), 12);
  expect(calc('PRICEMAT(45292.9,45400.5,45291.5,0.05,0.05)')).toBeCloseTo(calc('PRICEMAT(45292,45400,45291,0.05,0.05)'), 9);
  expect(calc('ACCRINTM(45292.9,45293.1,0.05,1000)')).toBeCloseTo(calc('ACCRINTM(45292,45293,0.05,1000)'), 12);
});
