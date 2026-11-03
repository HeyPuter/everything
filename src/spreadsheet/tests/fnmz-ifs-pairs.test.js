import { describe, it, expect } from 'vitest';
import { calc, calcStored } from './helpers/calc.js';

// SUMIFS, COUNTIFS, AVERAGEIFS, MAXIFS and MINIFS take criteria as range/criterion pairs
// (criteria_range1, criteria1, [criteria_range2, criteria2], ...); a range without its
// criterion, or no pair at all, is #VALUE! rather than a total of everything.
const VALUE = { error: '#VALUE!' };
const DATA = { A1: 1, A2: 2, A3: 3, B1: 10, B2: 20, B3: 30 };

describe('the *IFS functions without a complete criteria pair', () => {
  it('are #VALUE!', () => {
    expect(calcStored('SUMIFS(B1:B3,A1:A3)', DATA)).toEqual(VALUE);
    expect(calcStored('SUMIFS(B1:B3)', DATA)).toEqual(VALUE);
    expect(calcStored('COUNTIFS(A1:A3)', DATA)).toEqual(VALUE);
    expect(calc('COUNTIFS(A1:A3,">1",B1:B3)', DATA)).toEqual(VALUE);
    expect(calcStored('AVERAGEIFS(B1:B3,A1:A3)', DATA)).toEqual(VALUE);
    expect(calcStored('MAXIFS(B1:B3,A1:A3)', DATA)).toEqual(VALUE);
    expect(calcStored('MINIFS(B1:B3,A1:A3)', DATA)).toEqual(VALUE);
  });

  it('answer as before with complete pairs', () => {
    expect(calc('SUMIFS(B1:B3,A1:A3,">1")', DATA)).toBe(50);
    expect(calc('SUMIFS(B1:B3,A1:A3,">1",B1:B3,"<30")', DATA)).toBe(20);
    expect(calc('COUNTIFS(A1:A3,">1")', DATA)).toBe(2);
    expect(calc('AVERAGEIFS(B1:B3,A1:A3,">1")', DATA)).toBe(25);
    expect(calc('MAXIFS(B1:B3,A1:A3,"<3")', DATA)).toBe(20);
    expect(calc('MINIFS(B1:B3,A1:A3,">1")', DATA)).toBe(20);
  });
});
