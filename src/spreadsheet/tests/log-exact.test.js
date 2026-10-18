import { expect, it } from 'vitest';
import { calc } from './helpers/calc.js';

it('returns exact whole numbers for exact powers', () => {
  expect(calc('LOG(1000)')).toBe(3);
  expect(calc('INT(LOG(1000))')).toBe(3);
  expect(calc('LOG(1000,10)')).toBe(3);
  expect(calc('LOG(1000000,100)')).toBe(3);
  expect(calc('LOG(125,5)')).toBe(3);
  expect(calc('LOG(8,2)')).toBe(3);
  expect(calc('LOG(10,10)')).toBe(1);
  expect(calc('LOG(1)')).toBe(0);
  expect(calc('LEN(1234567)')).toBe(calc('INT(LOG(1234567))+1'));
});

it('keeps ordinary values and domain errors', () => {
  expect(calc('LOG(2)')).toBeCloseTo(0.30103, 5);
  expect(calc('LOG(7,3)')).toBeCloseTo(1.77124, 5);
  expect(calc('LOG(0)')).toEqual({ error: '#NUM!' });
  expect(calc('LOG(5,1)')).toEqual({ error: '#DIV/0!' }); // the logarithm of the base is zero
  expect(calc('LOG(-1)')).toEqual({ error: '#NUM!' });
});
