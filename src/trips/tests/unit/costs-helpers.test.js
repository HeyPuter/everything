import { describe, expect, it, vi } from 'vitest';
import { decimalInput, decimalsEqual, evenPercents, moneyInput, parseDecimal, parseMoney } from '../../src/lib/costs/input.js';
import { CSV_LABELS, costsRows, csvCell, csvFileName, toCsv } from '../../src/lib/costs/csv.js';
import { CATEGORY_IDS, orderedCategories } from '../../src/lib/costs/categories.js';
import { fetchRate, localToday, rateDate, resolvePending } from '../../src/lib/costs/fx.js';
import { settleAllEffects } from '../../src/lib/costs/adapters.js';

describe('typed numbers', () => {
  it.each([
    ['12.5', 'en', '12.5'], ['12,5', 'en', '12.5'], ['12,50', 'de', '12.5'], ['1,000', 'en', '1000'], ['1.000', 'de', '1000'],
    ['1,000', 'de', '1'], ['1.000', 'en', '1'], ['1,234.56', 'en', '1234.56'], ['1.234,56', 'de', '1234.56'],
    ['1 234,56', 'fr', '1234.56'], ['1 234,56', 'fr', '1234.56'], ["1'234.50", 'de-CH', '1234.5'], ['1,234,567.89', 'en', '1234567.89'],
    ['1.234.567', 'en', '1234567'], ['.5', 'en', '0.5'], ['5.', 'en', '5'], ['007', 'en', '7'], ['-3', 'en', '-3'], ['−3,5', 'de', '-3.5'],
    ['-0', 'en', '0'], ['+4', 'en', '4'], ['0.10', 'en', '0.1'],
  ])('%s (%s) is %s', (text, locale, expected) => expect(parseDecimal(text, locale)).toBe(expected));

  it.each(['', ' ', 'abc', '1e3', '--1', '1.2.3,4,5', '12a', '.', ',', null, undefined, 12])('rejects %s', (text) => expect(parseDecimal(text, 'en')).toBeNull());

  it('parses money in the currency’s minor units', () => {
    expect(parseMoney('12.34', 'EUR')).toBe(1234);
    expect(parseMoney('1.234', 'KWD')).toBe(1234);
    expect(parseMoney('1,234', 'JPY', 'en')).toBe(1234);
    expect(parseMoney('12,30', 'EUR', 'de')).toBe(1230);
    expect(parseMoney('-5', 'USD')).toBe(-500);
    expect(() => parseMoney('12.345', 'EUR')).toThrow('too_many_decimals');
    expect(() => parseMoney('1.5', 'JPY')).toThrow('too_many_decimals');
    expect(() => parseMoney('x', 'EUR')).toThrow('invalid_amount');
  });

  it('formats inputs in the locale’s decimal separator', () => {
    expect(moneyInput(1234, 'EUR', 'en')).toBe('12.34');
    expect(moneyInput(1234, 'EUR', 'de')).toBe('12,34');
    expect(moneyInput(5, 'JPY', 'de')).toBe('5');
    expect(moneyInput(null, 'EUR')).toBe('');
    expect(decimalInput('33.5', 'de')).toBe('33,5');
    expect(decimalInput(undefined)).toBe('');
  });

  it('builds even percentages that total exactly 100', () => {
    for (let count = 1; count <= 50; count++) {
      const values = evenPercents(count, 'x');
      expect(values).toHaveLength(count);
      expect(decimalsEqual(values, 100)).toBe(true);
    }
    expect(evenPercents(3, '0000000000000001').sort()).toEqual(['33.33', '33.33', '33.34']);
    expect(evenPercents(2)).toEqual(['50', '50']);
    expect(decimalsEqual(['33.33', '33.33', '33.33'], 100)).toBe(false);
    expect(decimalsEqual(['99.999', '0.001'], 100)).toBe(true);
  });
});

describe('CSV export', () => {
  const label = (key) => `[${key}]`;
  const names = { a: 'Ana', b: 'Ben' };
  const name = (who) => names[who] ?? who;
  const category = (id) => `cat:${id}`;

  it('quotes cells and guards formulas but not numbers', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1 call')).toBe("'+1 call");
    expect(csvCell('@user')).toBe("'@user");
    expect(csvCell('-12.50')).toBe('-12.50');
    expect(csvCell('-3,5')).toBe('-3,5');
    expect(csvCell(null)).toBe('');
  });

  it('writes a UTF-8 BOM, semicolons and CRLF', () => {
    expect(toCsv([['a', 'b'], ['c;d', 'e']])).toBe('﻿a;b\r\n"c;d";e\r\n');
  });

  it('lists expenses with per-person shares, then settlements', () => {
    const rows = costsRows({
      tripCurrency: 'EUR', people: ['a', 'b'], name, category, label, locale: 'de',
      expenses: [{ id: '0000000000000002', name: 'Dinner', amount: 3001, currency: 'EUR', date: '2027-05-02', cat: 'food', payers: [{ who: 'a', amount: 3001 }], split: { mode: 'equal', parts: [{ who: 'a' }, { who: 'b' }] }, note: '=1+1' }],
      privateExpenses: [{ id: '0000000000000003', name: 'Gift', amount: 1000, currency: 'USD', rate: '0.9', payers: [{ who: 'a', amount: 1000 }], split: { mode: 'equal', parts: [{ who: 'a' }] } }],
      settlements: [{ id: '0000000000000004', from: 'b', to: 'a', amount: 1500, currency: 'USD', rate: null, date: '2027-05-03' }],
    });
    expect(rows[0]).toEqual(['[type]', '[date]', '[name]', '[category]', '[amount]', '[currency]', '[rate]', '[tripAmount] (EUR)', '[paidBy]', '[split]', 'Ana', 'Ben', '[note]']);
    expect(rows[1].slice(0, 10)).toEqual(['[expense]', '2027-05-02', 'Dinner', 'cat:food', '30,01', 'EUR', '', '30,01', 'Ana 30,01', '[mode.equal]']);
    expect(rows[1].slice(10, 12).sort()).toEqual(['15,00', '15,01']);
    expect(rows[2].slice(0, 8)).toEqual(['[private]', '', 'Gift', 'cat:undefined', '10,00', 'USD', '0,9', '9,00']);
    expect(rows[3].slice(0, 8)).toEqual(['[settlement]', '2027-05-03', 'Ben → Ana', '', '15,00', 'USD', '[pending]', '']);
    const text = toCsv(rows);
    expect(text).toContain("'=1+1");
    expect(text.startsWith('﻿')).toBe(true);
    expect(CSV_LABELS).toContain('mode.items');
  });

  it('builds a safe file name', () => {
    expect(csvFileName('Lisbon / Porto: "2027"', '2027-01-01')).toBe('Lisbon Porto 2027 costs 2027-01-01.csv');
    expect(csvFileName('', '2027-01-01')).toBe('trip costs 2027-01-01.csv');
  });
});

describe('category order', () => {
  it('puts ordered categories first and keeps the rest in default order', () => {
    expect(orderedCategories([])).toEqual(CATEGORY_IDS);
    const order = orderedCategories([
      { id: 'x1', cat: 'tips', order: 'b' }, { id: 'x2', cat: 'food', order: 'a' }, { id: 'x3', cat: 'tips', order: 'Z' },
      { id: 'x4', cat: 'nope', order: 'a' }, { id: 'x5', cat: 'fuel', order: 'not valid!' },
    ]);
    expect(order.slice(0, 2)).toEqual(['tips', 'food']);
    expect(order).toHaveLength(CATEGORY_IDS.length);
    expect(new Set(order).size).toBe(CATEGORY_IDS.length);
  });
});

describe('rates', () => {
  const result = { data: { base: 'USD', date: '2027-05-01', rates: { USD: 1, EUR: 0.9, JPY: 150 } }, provider: 'frankfurter' };

  it('asks for the entity date unless it is in the future', () => {
    expect(rateDate('2027-05-01', '2027-06-01')).toBe('2027-05-01');
    expect(rateDate('2027-07-01', '2027-06-01')).toBeUndefined();
    expect(rateDate(null, '2027-06-01')).toBeUndefined();
    expect(localToday(new Date(2027, 0, 5))).toBe('2027-01-05');
  });

  it('freezes a rate string or answers null', async () => {
    const fx = { rates: vi.fn(async () => result) };
    expect(await fetchRate({ fx, from: 'USD', to: 'EUR', date: '2027-05-01', today: '2027-06-01' })).toBe('0.9');
    expect(fx.rates).toHaveBeenCalledWith('USD', '2027-05-01', { signal: undefined });
    expect(await fetchRate({ fx: { rates: async () => null }, from: 'USD', to: 'EUR' })).toBeNull();
    expect(await fetchRate({ fx: { rates: async () => { throw new Error('down'); } }, from: 'USD', to: 'EUR' })).toBeNull();
    expect(await fetchRate({ fx: null, from: 'USD', to: 'EUR' })).toBeNull();
    expect(await fetchRate({ fx, from: 'EUR', to: 'EUR' })).toBeNull();
  });

  it('fetches each pending currency and date once', async () => {
    const fx = { rates: vi.fn(async () => result) };
    const entities = [
      { id: '1', currency: 'USD', rate: null, date: '2027-05-01' }, { id: '2', currency: 'USD', rate: null, date: '2027-05-01' },
      { id: '3', currency: 'USD', rate: null, date: '2027-05-02' }, { id: '4', currency: 'EUR' }, { id: '5', currency: 'USD', rate: '0.8' },
    ];
    const resolved = await resolvePending({ fx, entities, tripCurrency: 'EUR', today: '2027-06-01' });
    expect(fx.rates).toHaveBeenCalledTimes(2);
    expect(resolved.map((item) => [item.entity.id, item.rate])).toEqual([['1', '0.9'], ['2', '0.9'], ['3', '0.9']]);
  });
});

describe('settle-all adapter', () => {
  it('creates one settlement per transfer with the client ids', () => {
    const transfers = [{ from: 'a', to: 'b', amount: 5, currency: 'EUR' }, { from: 'c', to: 'b', amount: 7, currency: 'EUR' }];
    expect(settleAllEffects({ transfers, newIds: { settle: ['1', '2'] } })).toEqual([
      { t: 'settle', id: '1', put: transfers[0] }, { t: 'settle', id: '2', put: transfers[1] },
    ]);
  });
});
