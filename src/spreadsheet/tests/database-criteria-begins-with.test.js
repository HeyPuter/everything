import { expect, it } from 'vitest';
import { calc } from './helpers/calc.js';

const DB = {
  A1: 'Tree', B1: 'Profit',
  A2: 'Apple', B2: '105',
  A3: 'Apple Pie', B3: '96',
  A4: 'Pear', B4: '10',
  A5: 'apple', B5: '7',
  A6: 'Pineapple', B6: '1',
  D1: 'Tree', D2: 'Apple',
  E1: 'Tree', E2: '="=Apple"',
  F1: 'Tree', F2: 'A?ple P',
  G1: 'Profit', G2: '10',
  H1: 'Tree', H2: '<>Apple',
};

// A criterion of plain text finds the records whose field begins with it, as the advanced filter's
// criteria do; ="=Apple" is how a criteria range asks for the whole value.
it('reads plain text criteria as "begins with"', () => {
  expect(calc('DSUM(A1:B6,"Profit",D1:D2)', DB)).toBe(208);
  expect(calc('DCOUNTA(A1:B6,"Tree",D1:D2)', DB)).toBe(3);
  expect(calc('DGET(A1:B6,"Profit",D1:D2)', DB)).toEqual({ error: '#NUM!' });
  expect(calc('DSUM(A1:B6,"Profit",F1:F2)', DB)).toBe(96);
});

it('keeps exact criteria, numbers and comparisons as they were', () => {
  expect(calc('DSUM(A1:B6,"Profit",E1:E2)', DB)).toBe(112);
  expect(calc('DGET(A1:B6,"Tree",G1:G2)', DB)).toBe('Pear');
  expect(calc('DSUM(A1:B6,"Profit",H1:H2)', DB)).toBe(107);
});
