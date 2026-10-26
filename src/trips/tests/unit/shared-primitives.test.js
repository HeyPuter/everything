import { describe, expect, it, vi } from 'vitest';
import { createIdGenerator, isId } from '../../src/shared/ids.js';
import { createClock, compareHlc, parseHlc } from '../../src/shared/hlc.js';
import { orderBetween, orderKeys, isOrder } from '../../src/shared/order.js';
import { addDays, isDate, isTime, isTimeZone, daysBetween, dateRange, zonedInstant, zonedParts, browserTimeZone, timeMinutes, minutesTime } from '../../src/shared/dates.js';
import { workerOrigin, trustedWorkerURL, spaceRoute, entityKey } from '../../src/shared/protocol.js';

const node = '0000000000000001';
describe('ids and clocks', () => {
  it('keeps ids sortable through the same millisecond and a clock rollback', () => {
    let now = 100;
    const generate = createIdGenerator({ now: () => now, random: (bytes) => bytes.fill(0) });
    const first = generate();
    const second = generate();
    now = 99;
    const third = generate();
    now = 101;
    const fourth = generate();
    expect([first, second, third, fourth].every(isId)).toBe(true);
    expect([first, second, third, fourth]).toEqual([first, second, third, fourth].sort());
    expect(new Set([first, second, third, fourth]).size).toBe(4);
  });
  it('carries a saturated random suffix without duplicate ids', () => {
    const generate = createIdGenerator({ now: () => 100, random: (bytes) => bytes.fill(255) });
    const first = generate();
    const second = generate();
    expect(first < second).toBe(true);
  });
  it('rejects invalid timestamps and noncanonical ids', () => {
    expect(() => createIdGenerator({ now: () => -1 })()).toThrow('invalid_time');
    expect(isId('llllllllllllllll')).toBe(false);
    expect(isId('000000000000000A')).toBe(false);
  });
  it('merges remote clocks and stays monotonic after rollback', () => {
    let now = 1000;
    const clock = createClock({ node, now: () => now });
    const remote = createClock({ node: '0000000000000002', now: () => 2000 }).tick();
    const versions = [clock.tick(), clock.tick(remote)];
    now = 500;
    versions.push(clock.tick());
    expect(versions).toEqual([...versions].sort());
    expect(compareHlc(versions[1], remote)).toBe(1);
    expect(parseHlc(versions[2])).toEqual({ time: 2000, counter: 2, node });
    expect(() => clock.tick('invalid')).toThrow('invalid_version');
  });
});

describe('fractional order', () => {
  it('generates stable balanced keys, including bounds', () => {
    const keys = orderKeys(1000);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(1000);
    expect(keys.every(isOrder)).toBe(true);
    for (let index = 1; index < keys.length; index++) {
      const middle = orderBetween(keys[index - 1], keys[index]);
      expect(middle > keys[index - 1] && middle < keys[index]).toBe(true);
    }
    expect(orderBetween(null, keys[0]) < keys[0]).toBe(true);
    expect(orderBetween(keys.at(-1), null) > keys.at(-1)).toBe(true);
  });
  it('handles prefix-adjacent keys and repeated moves', () => {
    for (const [left, right] of [[null, '0V'], ['V', 'V0V'], ['z', 'zV'], ['0V', '1']]) {
      const value = orderBetween(left, right);
      expect((left === null || left < value) && value < right).toBe(true);
    }
    expect(() => orderBetween('0', 'V')).toThrow('invalid_order');
    expect(() => orderBetween('z', 'A')).toThrow('invalid_order_bounds');
    expect(() => orderKeys(-1)).toThrow('invalid_count');
  });
});

describe('calendar arithmetic', () => {
  it.each([['2024-02-29', true], ['2025-02-29', false], ['1900-02-29', false], ['2000-02-29', true], ['0000-01-01', false], ['0099-01-01', true], ['2026-2-01', false], ['2026-01-32', false]])('validates %s', (date, valid) => {
    expect(isDate(date)).toBe(valid);
  });
  it('adds civil days independently of DST and handles years below 100', () => {
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('0099-12-31', 1)).toBe('0100-01-01');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(dateRange('2026-10-24', '2026-10-26')).toHaveLength(3);
    expect(() => dateRange('2026-10-26', '2026-10-24')).toThrow('invalid_date_range');
    expect(() => addDays('9999-12-31', 1)).toThrow('date_out_of_range');
  });
  it('rejects invalid clock times and fixed offsets as IANA zones', () => {
    expect(isTime('23:59')).toBe(true);
    expect(isTime('24:00')).toBe(false);
    expect(isTimeZone('America/Vancouver')).toBe(true);
    expect(isTimeZone('+05:30')).toBe(false);
    expect(isTimeZone('Missing/Zone')).toBe(false);
    expect(minutesTime(timeMinutes('12:34'))).toBe('12:34');
  });
  it('rejects nonexistent DST times and requires a choice for repeated times', () => {
    expect(() => zonedInstant('2026-03-08', '02:30', 'America/Vancouver')).toThrow('nonexistent_local_time');
    expect(() => zonedInstant('2026-11-01', '01:30', 'America/Vancouver')).toThrow('ambiguous_local_time');
    const early = zonedInstant('2026-11-01', '01:30', 'America/Vancouver', { disambiguation: 'earlier' });
    const late = zonedInstant('2026-11-01', '01:30', 'America/Vancouver', { disambiguation: 'later' });
    expect(late - early).toBe(3_600_000);
    expect(zonedParts(early, 'America/Vancouver').time).toBe('01:30');
  });
  it('converts time zones across midnight, non-hour offsets and the date line', () => {
    expect(new Date(zonedInstant('2026-10-24', '09:00', 'Asia/Kathmandu')).toISOString()).toBe('2026-10-24T03:15:00.000Z');
    const tokyo = zonedInstant('2026-10-24', '00:30', 'Asia/Tokyo');
    expect(zonedParts(tokyo, 'America/Vancouver').date).toBe('2026-10-23');
  });
  it('uses UTC if a browser cannot supply a timezone', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => { throw new Error('unavailable'); });
    expect(browserTimeZone()).toBe('UTC');
  });
});

describe('trusted worker references', () => {
  it('builds canonical origins and routes', () => {
    expect(workerOrigin('trips-012345abcd')).toBe('https://trips-012345abcd.puter.work');
    expect(spaceRoute({ w: 'trips-012345abcd', s: node, k: 'trip' })).toBe(`#/t/trips-012345abcd/${node}`);
    expect(entityKey(node, 'msg', node)).toBe(`shared:${node}:m:${node}`);
  });
  it.each(['http://trips-012345abcd.puter.work/', 'https://evil.com/', 'https://trips-012345abcd.puter.work.evil.com/', 'https://a@trips-012345abcd.puter.work/', 'https://trips-012345abcd.puter.work:444/', 'https://trips-012345abcd.puter.work/#token', 'https://trips-012345abcd.puter.work\\@evil.com/'])('refuses %s', (url) => {
    expect(() => trustedWorkerURL(url)).toThrow('untrusted_worker');
  });
});
