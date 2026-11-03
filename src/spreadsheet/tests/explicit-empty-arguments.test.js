import { describe, expect, it } from 'vitest';
import { calc, calcStored } from './helpers/calc.js';

// An argument left empty between commas is a value to the function, 0, FALSE or "" by
// context, not an omission that falls back to the default.
const TABLE = { A1: 'aa', B1: '1', A2: 'bb', B2: '2', A3: 'cc', B3: '3' };
const E = (code) => ({ error: code });

describe('explicit empty arguments', () => {
  it('make VLOOKUP, HLOOKUP and MATCH match exactly', () => {
    expect(calc('VLOOKUP("bc",A1:B3,2,)', TABLE)).toEqual(E('#N/A'));
    expect(calc('VLOOKUP("bc",A1:B3,2)', TABLE)).toBe(2); // omitted: approximate, as before
    expect(calc('VLOOKUP("bb",A1:B3,2,)', TABLE)).toBe(2);
    expect(calc('HLOOKUP("bc",{"aa","bb","cc";1,2,3},2,)')).toEqual(E('#N/A'));
    expect(calc('MATCH("bb",A1:A3,)', { A1: 'cc', A2: 'aa', A3: 'bb' })).toBe(3);
    expect(calc('MATCH("zz",A1:A3,)', TABLE)).toEqual(E('#N/A'));
  });

  it('read as 0 in text and math functions', () => {
    expect(calc('LEFT("abc",)')).toBe('');
    expect(calc('RIGHT("abc",)')).toBe('');
    expect(calc('ROUND(2.5,)')).toBe(3);
    expect(calc('SUBSTITUTE("aaa","a","b",)')).toEqual(E('#VALUE!'));
    expect(calc('FIND("a","abc",)')).toEqual(E('#VALUE!'));
    expect(calc('MID("abc",,2)')).toEqual(E('#VALUE!'));
  });

  it('count as the number 0 in aggregates, unlike a blank cell', () => {
    expect(calc('COUNT(1,)')).toBe(2);
    expect(calc('AVERAGE(1,)')).toBe(0.5);
    expect(calc('MAX(-5,)')).toBe(0);
    expect(calc('MIN(5,)')).toBe(0);
    expect(calc('PRODUCT(5,)')).toBe(0);
    expect(calc('SUM(1,)')).toBe(1);
    expect(calc('SUM(,1)')).toBe(1);
    // A reference to an empty cell is still ignored.
    expect(calc('COUNT(1,D1)')).toBe(1);
    expect(calc('MAX(-5,D1)')).toBe(-5);
    expect(calc('AVERAGE(D1)')).toEqual(E('#DIV/0!'));
  });

  it('read as "" and FALSE where text or a flag is expected', () => {
    expect(calc('CONCAT("a",)')).toBe('a');
    expect(calc('TEXTJOIN(",",FALSE,"a",)')).toBe('a,');
    expect(calc('TEXTJOIN(",",TRUE,"a",)')).toBe('a');
    expect(calcStored('LEN(T())')).toBe(0);
    expect(calc('AND(TRUE,)')).toBe(false);
    expect(calc('OR(TRUE,)')).toBe(true);
    expect(calc('IF(TRUE,,"y")')).toBe(0);
  });

  it('are read the same by a built-in called through a name', () => {
    expect(calc('LET(fn,VLOOKUP,fn("bc",A1:B3,2,))', TABLE)).toEqual(E('#N/A'));
    expect(calc('LET(fn,LEFT,fn("abc",))')).toBe('');
    expect(calc('LET(fn,ADDRESS,fn(2,3,,FALSE))')).toBe('R2C3');
  });

  it('keep the default where the idiom depends on it', () => {
    expect(calc('ROWS(OFFSET(A1,1,0,,2))', TABLE)).toBe(1);
    expect(calc('COLUMNS(OFFSET(A1,1,0,,2))', TABLE)).toBe(2);
    expect(calc('XLOOKUP("zz",A1:A3,B1:B3,,2)', TABLE)).toEqual(E('#N/A'));
    expect(calc('ADDRESS(2,3,,)')).toBe('$C$2');
    expect(calc('INDEX(SEQUENCE(3,,5),3)')).toBe(7);
    expect(calc('SUM(TAKE(SEQUENCE(3,2),,1))')).toBe(9);
    expect(calc('RATE(12,-100,1000,,,)')).toBeCloseTo(0.0292, 3);
  });

  it('never show the empty marker itself', () => {
    expect(calc('ARRAYFORMULA()')).toEqual(E('#N/A'));
    expect(calcStored('TYPE(N())')).toBe(1);
    expect(calcStored('ISNUMBER(N())')).toBe(true);
    expect(calc('REDUCE(,{1,2},LAMBDA(a,b,a))')).toBe(0);
  });
});
