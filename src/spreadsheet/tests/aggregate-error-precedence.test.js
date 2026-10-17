import { describe, expect, it } from 'vitest';
import { calc } from './helpers/calc.js';

// A function reading its arguments in turn answers with the first error among them, even when an
// earlier one is a reference (read only once the function runs) and a later one an error given directly.
const DATA = { A1: '=1/0', A2: '=NA()', B1: '1', B2: '2' };
const DIV0 = { error: '#DIV/0!' }, NA = { error: '#N/A' };

describe('error precedence across arguments', () => {
  it('reports an error read from an earlier reference first', () => {
    expect(calc('SUM(A1,NA())', DATA)).toEqual(DIV0);
    expect(calc('SUM(A1:A1,NA())', DATA)).toEqual(DIV0);
    expect(calc('SUM(B1:B2,A1,NA())', DATA)).toEqual(DIV0);
    expect(calc('MAX(A1,NA())', DATA)).toEqual(DIV0);
    expect(calc('AVERAGE(A2,1/0)', DATA)).toEqual(NA);
    expect(calc('PRODUCT(5,A2,1/0)', DATA)).toEqual(NA);
    expect(calc('AND(A1,NA())', DATA)).toEqual(DIV0);
    expect(calc('MEDIAN(A2,1/0)', DATA)).toEqual(NA);
    expect(calc('STDEV(A1,NA())', DATA)).toEqual(DIV0);
    expect(calc('CONCAT(A1:A2,NA())', DATA)).toEqual(DIV0);
  });

  it('still reports a direct error that comes first, or the only one', () => {
    expect(calc('SUM(NA(),A1)', DATA)).toEqual(NA);
    expect(calc('SUM(B1:B2,1/0)', DATA)).toEqual(DIV0);
    expect(calc('SUM(B1,NA())', DATA)).toEqual(NA);
    expect(calc('A1+NA()', DATA)).toEqual(DIV0);
  });

  it('leaves functions that do not read their references as before', () => {
    expect(calc('INDEX(A1:A2,NA())', DATA)).toEqual(NA);
    expect(calc('OFFSET(A1,NA(),0)', DATA)).toEqual(NA);
  });
});
