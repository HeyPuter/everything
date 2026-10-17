import { describe, expect, it } from 'vitest';
import { calc } from './helpers/calc.js';

// REGEXEXTRACT, VALUETOTEXT and FORECAST's x take a single value; handed an array they answer
// one value per element (and spill), rather than #VALUE! or the text "#VALUE!".
const D = { C1: 'a1', C2: 'b22', C3: 'c333', D1: '1', D2: '2', D3: '3', E1: '10', E2: '20', E3: '30', F1: '=1/0' };

describe('single-value text and forecast arguments over arrays', () => {
  it('REGEXEXTRACT extracts from each element', () => {
    expect(calc('INDEX(REGEXEXTRACT(C1:C3,"[0-9]+"),3)', D)).toBe('333');
    expect(calc('ROWS(REGEXEXTRACT(C1:C3,"[0-9]+"))', D)).toBe(3);
    expect(calc('REGEXEXTRACT(C2,"[0-9]+")', D)).toBe('22');
  });

  it('VALUETOTEXT turns each element into text, and is never an error text for a range', () => {
    expect(calc('INDEX(VALUETOTEXT(C1:C3),2)', D)).toBe('b22');
    expect(calc('ISERROR(INDEX(VALUETOTEXT(C1:C3),1))', D)).toBe(false);
    expect(calc('INDEX(VALUETOTEXT(D1:F1,1),3)', D)).toBe('#DIV/0!');
    expect(calc('INDEX(VALUETOTEXT({"x";1},1),1)')).toBe('"x"');
  });

  it('FORECAST and FORECAST.LINEAR forecast each x', () => {
    expect(calc('SUM(FORECAST({4;5;6},E1:E3,D1:D3))', D)).toBe(150);
    expect(calc('INDEX(FORECAST.LINEAR({4,5},E1:E3,D1:D3),2)', D)).toBe(50);
    expect(calc('FORECAST(4,E1:E3,D1:D3)', D)).toBe(40);
  });
});
