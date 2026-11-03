import { describe, expect, it } from 'vitest';
import { calc, calcStored } from './helpers/calc.js';

const E = (code) => ({ error: code });

// XOR reads its arguments as AND and OR do: text and blanks in referenced cells are skipped,
// and when nothing logical remains there is no answer, #VALUE!, not a FALSE from counting
// zero TRUEs.
describe('XOR with no logical argument', () => {
  it('is #VALUE!, as AND and OR are', () => {
    expect(calc('XOR(A1)', { A1: 'text' })).toEqual(E('#VALUE!'));
    expect(calc('XOR(A1,A1)', { A1: 'text' })).toEqual(E('#VALUE!'));
    expect(calc('XOR(A1:A2)', { A1: 'text', A2: 'more' })).toEqual(E('#VALUE!'));
    expect(calc('XOR(A1)')).toEqual(E('#VALUE!')); // an empty cell
    expect(calcStored('XOR()')).toEqual(E('#VALUE!'));
    expect(calc('AND(A1,A1)', { A1: 'text' })).toEqual(E('#VALUE!'));
    expect(calc('OR(A1)', { A1: 'text' })).toEqual(E('#VALUE!'));
  });

  it('still answers from the logical arguments it finds', () => {
    // One TRUE among skipped text: an odd count of TRUEs.
    expect(calc('XOR(TRUE,A1)', { A1: 'text' })).toBe(true);
    expect(calc('XOR(A1:A3)', { A1: 'text', A2: 'TRUE', A3: '1' })).toBe(false); // two TRUEs
    expect(calc('XOR(1)')).toBe(true);
    expect(calc('XOR(0)')).toBe(false);
    expect(calc('XOR(TRUE,TRUE,TRUE)')).toBe(true);
    expect(calc('XOR(FALSE,FALSE)')).toBe(false);
    expect(calc('XOR("a")')).toEqual(E('#VALUE!')); // text given directly is read, and is not logical
  });
});
