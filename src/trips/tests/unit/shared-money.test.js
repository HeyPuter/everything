import { describe, expect, it } from 'vitest';
import { allocate, convertMinor, currencyDigits, fromMinor, roundRatio, splitAmount, toMinor, validatePayers } from '../../src/shared/money.js';

describe('minor units and FX', () => {
  it.each([['USD', '12.34', 1234], ['JPY', '123', 123], ['KWD', '1.234', 1234], ['CLF', '1.2345', 12345], ['USD', '-0.01', -1], ['USD', '90071992547409.91', Number.MAX_SAFE_INTEGER]])('%s parses exactly', (currency, decimal, amount) => {
    expect(toMinor(decimal, currency)).toBe(amount);
    expect(toMinor(fromMinor(amount, currency), currency)).toBe(amount);
  });
  it('rounds ties away from zero and never performs floating-point FX', () => {
    expect(roundRatio(5n, 2n)).toBe(3n);
    expect(roundRatio(-5n, 2n)).toBe(-3n);
    expect(toMinor('1.005', 'USD', { round: true })).toBe(101);
    expect(toMinor('-1.005', 'USD', { round: true })).toBe(-101);
    expect(convertMinor(100, '1.5', 'USD', 'JPY')).toBe(2);
    expect(convertMinor(150, '0.01', 'JPY', 'USD')).toBe(150);
    expect(convertMinor(10_000, '0.0067', 'JPY', 'USD')).toBe(6700);
  });
  it.each([() => toMinor('1.001', 'USD'), () => toMinor(0.1, 'USD'), () => toMinor('1e3', 'USD'), () => toMinor('90071992547409.92', 'USD'), () => currencyDigits('ZZZ'), () => convertMinor(100, '0', 'USD', 'USD')])('rejects ambiguous or unsafe money input', (operation) => {
    expect(operation).toThrow();
  });
});

describe('split allocation', () => {
  it('allocates the remainder deterministically, including refunds', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
    expect(allocate(5, ['0.1', '0.2', '0.7'])).toEqual([1, 1, 3]);
    expect(allocate(7, [0, 1])).toEqual([0, 7]);
  });
  it('rotates equal-split remainder recipients by expense id without reordering people', () => {
    const split = { mode: 'equal', parts: [{ who: 'a' }, { who: 'b' }] };
    const first = splitAmount(101, split, { expenseId: '0000000000000001' });
    const second = splitAmount(101, split, { expenseId: '0000000000000002' });
    expect(first.map((part) => part.who)).toEqual(['a', 'b']);
    expect(first.map((part) => part.amount)).not.toEqual(second.map((part) => part.amount));
    expect(splitAmount(101, split, { expenseId: '0000000000000001' })).toEqual(first);
  });
  it('uses numeric fractional weights from stored presets without floating-point arithmetic', () => {
    expect(allocate(100, [1, 0.5])).toEqual([67, 33]);
    expect(allocate(100, [1e-7, 2e-7])).toEqual([33, 67]);
  });
  it('conserves all minor units over many totals and weights', () => {
    for (let total = -100; total <= 100; total++) {
      for (let count = 1; count <= 10; count++) {
        const values = allocate(total, Array.from({ length: count }, (_, index) => index + 1));
        expect(values.reduce((sum, n) => sum + n, 0)).toBe(total);
        expect(values.every(Number.isSafeInteger)).toBe(true);
      }
    }
  });
  it.each([
    ['equal', [{ who: 'a' }, { who: 'b' }], [51, 50]],
    ['shares', [{ who: 'a', value: 2 }, { who: 'b', value: 1 }], [67, 34]],
    ['percent', [{ who: 'a', value: '33.33' }, { who: 'b', value: '66.67' }], [34, 67]],
    ['amounts', [{ who: 'a', value: 40 }, { who: 'b', value: 61 }], [40, 61]],
  ])('supports %s splits', (mode, parts, expected) => {
    expect(splitAmount(101, { mode, parts }).map((part) => part.amount)).toEqual(expected);
  });
  it('splits each line item only among its participants', () => {
    const split = { mode: 'items', parts: [{ who: 'a' }, { who: 'b' }, { who: 'c' }], items: [{ amount: 100, who: ['a', 'b'] }, { amount: 101, who: ['b', 'c'] }] };
    expect(splitAmount(201, split)).toEqual([{ who: 'a', amount: 50 }, { who: 'b', amount: 101 }, { who: 'c', amount: 50 }]);
  });
  it('accepts unpaid expenses without inventing a payer and rejects mismatched payments', () => {
    expect(validatePayers(100, [])).toBe(true);
    expect(() => validatePayers(100, [{ who: 'a', amount: 99 }])).toThrow('payer_total');
    expect(() => validatePayers(100, [{ who: 'a', amount: 50 }, { who: 'a', amount: 50 }])).toThrow('invalid_payers');
  });
  it('rejects duplicate participants, wrong totals and invalid weights', () => {
    expect(() => splitAmount(100, { mode: 'equal', parts: [{ who: 'a' }, { who: 'a' }] })).toThrow('invalid_participants');
    expect(() => splitAmount(100, { mode: 'percent', parts: [{ who: 'a', value: 90 }] })).toThrow('percent_total');
    expect(() => splitAmount(100, { mode: 'amounts', parts: [{ who: 'a', value: 99 }] })).toThrow('split_total');
    expect(() => allocate(100, [0, 0])).toThrow('invalid_weights');
    expect(() => allocate(100, [-1, 2])).toThrow('invalid_weights');
  });
});
