import { describe, expect, it } from 'vitest';
import { flashFill } from '../src/core/flashfill.js';

// Flash Fill could not learn to take the amount out of text such as "$1,234.50": the example 1234.50 was read as
// the digit runs 1 and 234 put together, which no other row repeats, so even two examples ($1,234.50 → 1234.50,
// $99.00 → 99.00) found no pattern. A number written with thousands separators or a decimal point is now one
// piece, without its separators, as it is in Excel.
const fill = (sources, targets) => flashFill(sources.map((s, i) => ({ sources: [s], target: targets[i] ?? null })));

describe('Flash Fill and numbers in text', () => {
  it('takes an amount out of currency text without its separators', () => {
    expect(fill(['$1,234.50', '$99.00', '$5.25', '$12,345.00'], ['1234.50', '99.00'])).toEqual([undefined, undefined, '5.25', '12345.00']);
    expect(fill(['Total: 1,234 units', 'Total: 56 units', 'Total: 7,890,123 units'], ['1234'])).toEqual([undefined, '56', '7890123']);
  });

  it('still reads digit runs as before', () => {
    expect(fill(['5551234567', '5559876543'], ['(555) 123-4567'])).toEqual([undefined, '(555) 987-6543']);
    expect(fill(['ABC-123-X', 'DEF-456-Y'], ['123'])).toEqual([undefined, '456']);
  });
});
