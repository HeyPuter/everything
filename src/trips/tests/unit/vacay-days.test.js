import { describe, expect, it } from 'vitest';
import { balance, bookable, bookableRange, dayStatus, entitlement, leaveMonths, leaveYear, leaveYearOf, usage, weekday } from '../../src/lib/vacay/days.js';
import { vacayKeys, parseKey } from '../../src/lib/vacay/keys.js';
import { cleanIndex, readCalendar, readRecord } from '../../src/lib/vacay/model.js';
import { validateVacay } from '../../src/shared/schema/index.js';

const plan = (extra = {}) => ({ weekendDays: [6, 0], weekStart: 1, yearType: 'calendar', ...extra });
const context = (extra = {}) => ({ weekendDays: [6, 0], holidays: new Set(), company: new Set(), ...extra });

describe('leave years', () => {
  it.each([
    [plan(), 2026, '2026-01-01', '2026-12-31'],
    [plan({ yearType: 'fiscal', startMonth: 4, startDay: 6 }), 2026, '2026-04-06', '2027-04-05'],
    [plan({ yearType: 'fiscal', startMonth: 9, startDay: 31 }), 2026, '2026-09-30', '2027-09-29'],
    [plan({ yearType: 'hire', hireDate: '2020-02-29' }), 2027, '2027-02-28', '2028-02-28'],
    [plan({ yearType: 'hire', hireDate: '2020-02-29' }), 2028, '2028-02-29', '2029-02-27'],
    [plan({ yearType: 'hire' }), 2026, '2026-01-01', '2026-12-31'],
  ])('%j year %i runs %s to %s', (value, year, start, end) => {
    expect(leaveYear(value, year)).toEqual({ year, start, end });
  });
  it('finds the leave year of a date and the months it touches', () => {
    const fiscal = plan({ yearType: 'fiscal', startMonth: 4, startDay: 6 });
    expect(leaveYearOf(fiscal, '2026-04-05')).toBe(2025);
    expect(leaveYearOf(fiscal, '2026-04-06')).toBe(2026);
    expect(leaveMonths(fiscal, 2026)).toHaveLength(13);
    expect(leaveMonths(fiscal, 2026)[0]).toEqual({ year: 2026, month: 4 });
    expect(leaveMonths(fiscal, 2026).at(-1)).toEqual({ year: 2027, month: 4 });
    expect(leaveMonths(plan(), 2026)).toHaveLength(12);
  });
  it('knows weekdays', () => {
    expect(weekday('2024-01-01')).toBe(1);
    expect(weekday('2026-10-25')).toBe(0);
    expect(weekday('2000-01-01')).toBe(6);
  });
});

describe('deductions', () => {
  const holidays = new Set(['2026-05-01']);
  const company = new Set(['2026-12-24']);
  it('blocks weekends and holidays and marks company days', () => {
    expect(dayStatus('2026-05-02', context())).toBe('weekend');
    expect(dayStatus('2026-05-01', context({ holidays }))).toBe('holiday');
    expect(dayStatus('2026-12-24', context({ company }))).toBe('company');
    expect(dayStatus('2026-05-04', context())).toBe(null);
    expect(bookable('2026-12-24', context({ company }))).toBe(true);
    expect(bookable('2026-05-01', context({ holidays }))).toBe(false);
    expect(dayStatus('2026-05-01', context({ weekendDays: [5, 6] }))).toBe('weekend');
  });
  it('counts half days, comp days and waived company days separately', () => {
    const entries = new Map([
      ['2026-05-01', { fraction: 1, kind: 'vacation' }], // holiday
      ['2026-05-02', { fraction: 1, kind: 'vacation' }], // Saturday
      ['2026-05-04', { fraction: 1, kind: 'vacation' }],
      ['2026-05-05', { fraction: 0.5, kind: 'vacation' }],
      ['2026-05-06', { fraction: 0.5, kind: 'comp' }],
      ['2026-05-07', { fraction: 1, kind: 'comp' }],
      ['2026-12-24', { fraction: 1, kind: 'vacation' }],
      ['2027-01-04', { fraction: 1, kind: 'vacation' }], // next year
    ]);
    expect(usage(entries, { start: '2026-01-01', end: '2026-12-31', ...context({ holidays, company }) })).toEqual({ used: 1.5, comp: 1.5, waived: 1 });
    expect(usage({ '2026-05-04': { fraction: 0.5, kind: 'vacation' } }, { start: '2026-01-01', end: '2026-12-31', ...context() }).used).toBe(0.5);
  });
  it('lists bookable dates in a range either way round', () => {
    expect(bookableRange('2026-05-08', '2026-04-30', context({ holidays }))).toEqual(['2026-04-30', '2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08']);
    expect(bookableRange('2026-01-01', '2026-12-31', context(), 3)).toHaveLength(3);
  });
});

describe('entitlement and carry-over', () => {
  const allowances = new Map([[2024, { days: 25 }], [2026, { days: 28 }]]);
  it('inherits the closest earlier year', () => {
    expect(entitlement(allowances, 2023)).toBe(0);
    expect(entitlement(allowances, 2025)).toBe(25);
    expect(entitlement(allowances, 2027)).toBe(28);
  });
  it('carries unused days forward up to the cap and never carries a deficit', () => {
    const used = { 2024: 20, 2025: 33, 2026: 10 };
    const usedOf = (year) => used[year] ?? 0;
    expect(balance(2024, { allowances, carryOver: 5, usedOf })).toEqual({ days: 25, carried: 0, total: 25, used: 20, remaining: 5 });
    expect(balance(2025, { allowances, carryOver: 5, usedOf })).toEqual({ days: 25, carried: 5, total: 30, used: 33, remaining: -3 });
    expect(balance(2026, { allowances, carryOver: 5, usedOf })).toEqual({ days: 28, carried: 0, total: 28, used: 10, remaining: 18 });
    expect(balance(2027, { allowances, carryOver: 5, usedOf })).toMatchObject({ days: 28, carried: 5, total: 33 });
    expect(balance(2027, { allowances, carryOver: 0, usedOf })).toMatchObject({ carried: 0, total: 28 });
    expect(balance(2027, { allowances, carryOver: 0.5, usedOf: () => 27.5 })).toMatchObject({ carried: 0.5, remaining: 1 });
  });
  it('uses a stored carry-over and starts with nothing carried in the first year', () => {
    const stored = new Map([[2025, { days: 20, carried: 3 }]]);
    expect(balance(2025, { allowances: stored, carryOver: 10, usedOf: () => 0 })).toMatchObject({ carried: 3, total: 23 });
    expect(balance(2026, { allowances: stored, carryOver: 10, usedOf: () => 0 })).toMatchObject({ carried: 10, total: 30 });
    expect(balance(2026, { allowances: stored, carryOver: 100, usedOf: () => 0 })).toMatchObject({ carried: 23, total: 43 });
    expect(balance(2026, { allowances: new Map(), carryOver: 5, usedOf: () => 2, firstYear: 2025 })).toMatchObject({ days: 0, carried: 0, remaining: -2 });
  });
});

describe('vacay keys and values', () => {
  it('lists indexed keys and parses relative and absolute keys', () => {
    const index = cleanIndex({ e: { '2026-07-01': 1, bad: 2 }, company: { '2026-12-24': 3 }, allow: { 2026: 4 }, cal: { abcdefghjkmnpqrs: 5 }, inv: { ['a'.repeat(32)]: 6 }, junk: { x: 1 } });
    expect(index.e).toEqual({ '2026-07-01': 1 });
    expect(vacayKeys(index).sort()).toEqual(['vacay:allow:2026', 'vacay:cal:abcdefghjkmnpqrs', 'vacay:company:2026-12-24', 'vacay:e:2026-07-01', 'vacay:grants', 'vacay:idx', `vacay:inv:${'a'.repeat(32)}`, 'vacay:plan', 'vacay:shares'].sort());
    expect(vacayKeys(null)).toEqual(['vacay:plan', 'vacay:idx', 'vacay:shares', 'vacay:grants']);
    expect(parseKey('e:2026-07-01')).toEqual({ group: 'e', id: '2026-07-01' });
    expect(parseKey('vacay:company:2026-12-24')).toEqual({ group: 'company', id: '2026-12-24' });
    expect(parseKey('vacay:e:2026-02-30')).toBe(null);
    expect(parseKey('plan')).toBe(null);
  });
  it('validates records, calendars and the index schema', () => {
    const hash = 'b'.repeat(32);
    const uid = '00000000-0000-4000-8000-000000000001';
    expect(readRecord('shares', { [hash]: { handle: 'h1', mode: 'fused', uid, name: ' Ann ' }, nothex: { handle: 'h2', mode: 'view' }, ['c'.repeat(32)]: { mode: 'view' } })).toEqual({ [hash]: { handle: 'h1', mode: 'fused', uid, name: 'Ann' } });
    expect(readCalendar({ type: 'school', region: 'DE-BY', label: 'Kids', periods: [] })).toMatchObject({ type: 'school', region: 'DE-BY', color: 2 });
    expect(readCalendar({ type: 'public', region: 'nowhere', label: 'X', periods: [] })).toBe(null);
    expect(readCalendar({ type: 'custom', label: 'Freeze', color: 3, periods: [{ start: '2026-12-01', end: '2026-11-01' }, { start: '2026-12-01', end: '2026-12-05' }] }).periods).toHaveLength(1);
    expect(validateVacay('allowance', { days: 25 }).days).toBe(25);
    expect(() => validateVacay('invite', { mode: 'fused', ack: 'nothex' })).toThrow('invalid');
    expect(validateVacay('index', { e: { '2026-01-02': 1 } }).e).toBeTruthy();
  });
});
