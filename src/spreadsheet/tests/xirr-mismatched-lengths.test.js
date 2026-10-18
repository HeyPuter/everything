import { expect, it } from 'vitest';
import { calc } from './helpers/calc.js';

// Values and dates of different counts are #NUM! for XIRR, as they are for XNPV; a date that is not a number stays #VALUE!.
it('answers #NUM! when values and dates differ in count', () => {
  expect(calc('XIRR({-100,50,60},{40000,40100})')).toEqual({ error: '#NUM!' });
  expect(calc('XIRR(A1:A3,B1:B2)', { A1: '-100', A2: '50', A3: '60', B1: '40000', B2: '40100' })).toEqual({ error: '#NUM!' });
  expect(calc('XNPV(0.1,{-100,50,60},{40000,40100})')).toEqual({ error: '#NUM!' });
});

it('keeps #VALUE! for a date that is not a number', () => {
  expect(calc('XIRR({-100,110},{40000,"x"})')).toEqual({ error: '#VALUE!' });
  expect(calc('XIRR({-100,110},{40000,40365})')).toBeCloseTo(0.1, 8);
});
