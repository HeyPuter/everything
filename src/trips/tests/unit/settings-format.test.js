import { describe, expect, it } from 'vitest';
import { defaultPrefs } from '../../src/lib/prefs.js';
import {
  formatDistance, formatTemperature, formatWeight, weightValue, parseWeight, unitLabel, formatMoney, displayCurrency, formatDate, formatTime,
  formatDateTime, formatInstant, formatDateRange, weekStart, weekdays, uses12Hour, formatDuration, formatNumber,
} from '../../src/lib/format.js';

const space = (text) => text.replace(/\s/g, ' ');
const at = (locale, overrides = {}) => ({ locale, prefs: { ...defaultPrefs(locale), ...overrides } });
const us = (overrides) => at('en-US', overrides);
const gb = (overrides) => at('en-GB', overrides);

describe('units', () => {
  it.each([
    [850, 'km', '850 m'], [42, 'km', '42 m'], [1234, 'km', '1.2 km'], [12_345, 'km', '12 km'],
    [1609.344, 'mi', '1 mi'], [16_093.44, 'mi', '10 mi'], [3218.688, 'mi', '2 mi'], [50, 'mi', '160 ft'], [-1234, 'km', '-1.2 km'],
  ])('formats %s m in %s', (meters, distanceUnit, expected) => {
    expect(space(formatDistance(meters, us({ distanceUnit })))).toBe(expected);
  });
  it.each([[21.4, 'c', '21°C'], [21.4, 'f', '71°F'], [-0.4, 'c', '0°C'], [-40, 'f', '-40°F'], [0, 'f', '32°F']])('formats %s °C as %s', (celsius, tempUnit, expected) => {
    expect(space(formatTemperature(celsius, us({ tempUnit })))).toBe(expected);
  });
  it.each([[850, 'kg', '850 g'], [1500, 'kg', '1.5 kg'], [1500, 'lb', '3.3 lb'], [200, 'lb', '7.1 oz'], [1_000_000, 'kg', '1,000 kg']])('formats %s g in %s', (grams, weightUnit, expected) => {
    expect(space(formatWeight(grams, us({ weightUnit })))).toBe(expected);
  });
  it('round-trips weight inputs', () => {
    expect(weightValue(1500, us({ weightUnit: 'lb' }))).toBe(3.31);
    expect(weightValue(1500, us({ weightUnit: 'kg' }))).toBe(1.5);
    expect(parseWeight('1,5', us({ weightUnit: 'kg' }))).toBe(1500);
    expect(parseWeight('2', us({ weightUnit: 'lb' }))).toBe(907);
    for (const bad of ['', ' ', '-1', 'abc', null]) expect(parseWeight(bad, us({ weightUnit: 'kg' }))).toBeNull();
  });
  it('labels units and ignores non-numbers', () => {
    expect(unitLabel('km', us())).toBe('km'); expect(unitLabel('c', us())).toBe('°C'); expect(unitLabel('lb', us())).toBe('lb');
    expect(formatDistance(NaN, us())).toBe(''); expect(formatTemperature(undefined, us())).toBe(''); expect(formatWeight(Infinity, us())).toBe('');
    expect(space(formatNumber(1234.567, us()))).toBe('1,234.57');
  });
});

describe('money', () => {
  it('formats minor units in the display locale and resolves the display currency', () => {
    expect(formatMoney(12_345, 'EUR', us())).toBe('€123.45');
    expect(space(formatMoney(12_345, 'EUR', at('de-DE')))).toBe('123,45 €');
    expect(formatMoney(1234, 'JPY', us())).toBe('¥1,234');
    expect(displayCurrency('EUR', us({ currency: null }))).toBe('EUR');
    expect(displayCurrency('EUR', us({ currency: 'USD' }))).toBe('USD');
  });
});

describe('dates and times', () => {
  it.each([
    ['auto', 'medium', 'en-US', 'Mar 7, 2026'], ['auto', 'numeric', 'en-US', '03/07/2026'], ['auto', 'numeric', 'en-GB', '07/03/2026'],
    ['auto', 'long', 'en-GB', '7 March 2026'], ['dmy', 'medium', 'en-US', '7 Mar 2026'], ['mdy', 'medium', 'en-GB', 'Mar 7, 2026'],
    ['dmy', 'numeric', 'en-US', '07/03/2026'], ['mdy', 'numeric', 'en-GB', '03/07/2026'], ['iso', 'medium', 'en-US', '2026-03-07'], ['iso', 'long', 'en-GB', '2026-03-07'],
  ])('formats a date as %s %s in %s', (dateFormat, style, locale, expected) => {
    expect(space(formatDate('2026-03-07', { ...at(locale, { dateFormat }), style }))).toBe(expected);
  });
  it('adds weekdays, drops years and rejects bad dates', () => {
    expect(formatDate('2026-03-07', { ...us({ dateFormat: 'dmy' }), weekday: true })).toBe('Sat 7 Mar 2026');
    expect(formatDate('2026-03-07', { ...us({ dateFormat: 'iso' }), weekday: true })).toBe('Sat 2026-03-07');
    expect(formatDate('2026-03-07', { ...us({ dateFormat: 'dmy' }), style: 'numeric', year: false })).toBe('07/03');
    expect(formatDate('2026-03-07', { ...us({ dateFormat: 'iso' }), year: false })).toBe('03-07');
    expect(formatDate('0099-01-02', { ...us({ dateFormat: 'iso' }) })).toBe('0099-01-02');
    expect(formatDate('2026-02-30', us())).toBe(''); expect(formatDate('07/03/2026', us())).toBe('');
  });
  it.each([
    ['14:05', 'auto', 'en-US', '2:05 PM'], ['14:05', 'auto', 'en-GB', '14:05'], ['14:05', '24', 'en-US', '14:05'], ['09:05', '24', 'en-US', '09:05'],
    ['14:05', '12', 'en-GB', '2:05 pm'], ['00:30', '12', 'en-US', '12:30 AM'], ['00:30', '24', 'en-US', '00:30'],
  ])('formats %s with %s in %s', (time, timeFormat, locale, expected) => {
    expect(space(formatTime(time, at(locale, { timeFormat })))).toBe(expected);
  });
  it('accepts minutes, rejects bad times and reports the hour cycle', () => {
    expect(formatTime(845, us({ timeFormat: '24' }))).toBe('14:05');
    expect(formatTime('24:00', us())).toBe(''); expect(formatTime(1440, us())).toBe(''); expect(formatTime('9:05', us())).toBe('');
    expect(uses12Hour(us())).toBe(true); expect(uses12Hour(gb())).toBe(false); expect(uses12Hour(gb({ timeFormat: '12' }))).toBe(true);
  });
  it('formats date-times, instants in a zone and ranges', () => {
    expect(space(formatDateTime('2026-03-07', '14:05', us({ dateFormat: 'iso', timeFormat: '24' })))).toBe('2026-03-07 14:05');
    // 23:30 UTC on 7 March is 08:30 on 8 March in Tokyo.
    expect(formatInstant(Date.UTC(2026, 2, 7, 23, 30), 'Asia/Tokyo', us({ dateFormat: 'iso', timeFormat: '24' }))).toBe('2026-03-08 08:30');
    expect(formatInstant(Date.UTC(2026, 2, 7, 23, 30), 'America/Los_Angeles', { ...us({ timeFormat: '24' }), date: false })).toBe('15:30');
    expect(formatDateRange('2026-03-07', '2026-03-10', us({ dateFormat: 'dmy' }))).toBe('7 Mar – 10 Mar 2026');
    expect(formatDateRange('2026-12-30', '2027-01-02', us({ dateFormat: 'dmy' }))).toBe('30 Dec 2026 – 2 Jan 2027');
    expect(formatDateRange('2026-03-07', '2026-03-10', us({ dateFormat: 'iso' }))).toBe('2026-03-07 – 2026-03-10');
    expect(space(formatDateRange('2026-03-07', '2026-03-10', us()))).toMatch(/^Mar 7 . 10, 2026$/);
    expect(formatDateRange('2026-03-07', '2026-03-07', us({ dateFormat: 'iso' }))).toBe('2026-03-07');
    expect(formatDateRange(null, '2026-03-07', us({ dateFormat: 'iso' }))).toBe('2026-03-07');
  });
  it('starts weeks on the preferred day', () => {
    expect(weekStart(us())).toBe(0); expect(weekStart(gb())).toBe(1);
    expect(weekStart(us({ weekStart: 'mon' }))).toBe(1); expect(weekStart(gb({ weekStart: 'sat' }))).toBe(6);
    expect(weekdays(gb()).map((day) => day.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(weekdays({ ...us(), style: 'long' })[0]).toEqual({ day: 0, label: 'Sunday' });
  });
  it('formats durations', () => {
    expect(space(formatDuration(85, us()))).toBe('1 hr 25 min');
    expect(space(formatDuration(45, us()))).toBe('45 min');
    expect(space(formatDuration(120, us()))).toBe('2 hr');
    expect(space(formatDuration(0, us()))).toBe('0 min');
    expect(formatDuration(-1, us())).toBe('');
  });
});
