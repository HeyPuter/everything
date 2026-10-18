import { describe, expect, it } from 'vitest';
import { calc } from './helpers/calc.js';
import { signatureFor } from '../src/core/formula/hints.js';

const E = (code) => ({ error: code });

// Excel's REGEXEXTRACT takes return_mode (0 the first match, 1 every match, 2 the first match's
// capture groups) and case_sensitivity. Both were ignored, so REGEXEXTRACT(A1,"\d+",1) gave only the
// first number instead of all of them, and case_sensitivity 1 still matched case.
describe('REGEXEXTRACT return_mode and case_sensitivity', () => {
  it('returns every match as a column with return_mode 1', () => {
    expect(calc('ROWS(REGEXEXTRACT("a1b22c333","\\d+",1))')).toBe(3);
    expect(calc('INDEX(REGEXEXTRACT("a1b22c333","\\d+",1),2)')).toBe('22');
    expect(calc('REGEXEXTRACT("abc","\\d",1)')).toEqual(E('#N/A'));
  });

  it('returns the whole first match with return_mode 0, the groups with 2', () => {
    expect(calc('REGEXEXTRACT("a=b","(\\w)=",0)')).toBe('a=');
    expect(calc('INDEX(REGEXEXTRACT("ab-cd","(\\w+)-(\\w+)",2),1,2)')).toBe('cd');
    expect(calc('REGEXEXTRACT("abc","b",3)')).toEqual(E('#VALUE!'));
  });

  it('ignores case with case_sensitivity 1', () => {
    expect(calc('REGEXEXTRACT("ABC","b",0,1)')).toBe('B');
    expect(calc('REGEXEXTRACT("ABC","b",0)')).toEqual(E('#N/A'));
    expect(calc('ROWS(REGEXEXTRACT("aXbx","x",1,1))')).toBe(2);
  });

  it('keeps the capture-group answer when return_mode is left out', () => {
    expect(calc('REGEXEXTRACT("a=b","(\\w)=")')).toBe('a');
    expect(calc('REGEXEXTRACT("order #4521","\\d+")')).toBe('4521');
  });

  it('advertises the arguments', () => {
    expect(signatureFor('REGEXEXTRACT').params).toBe('text, regular_expression, [return_mode], [case_sensitivity]');
  });
});
