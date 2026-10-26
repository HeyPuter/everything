// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { zonedParts } from '../../src/shared/dates.js';
import {
  comparePoints, instantOf, legDayOffset, legDuration, legIssues, minutesBetween, pointZoneLabel, rangeIssue, zonedEpoch, zoneLabel,
} from '../../src/lib/res/time.js';

const Z = (iso) => Date.parse(iso);
const leg = (from, dep, to, arr) => ({ from: { tz: from }, to: { tz: to }, dep: { date: dep[0], time: dep[1] }, arr: { date: arr[0], time: arr[1] } });

describe('zonedEpoch', () => {
  it.each([
    ['2027-05-01', '10:00', 'Europe/Lisbon', '2027-05-01T09:00:00Z'],
    ['2027-05-01', '10:00', 'Asia/Kolkata', '2027-05-01T04:30:00Z'],
    ['2027-01-15', '23:30', 'America/Los_Angeles', '2027-01-16T07:30:00Z'],
    ['2027-05-01', '00:00', 'Pacific/Kiritimati', '2027-04-30T10:00:00Z'],
  ])('%s %s in %s', (date, time, zone, expected) => {
    expect(zonedEpoch(date, time, zone)).toBe(Z(expected));
  });

  it('moves a time inside a spring-forward gap forward by the gap', () => {
    // New York skips 02:00–03:00 on 2027-03-14.
    const instant = zonedEpoch('2027-03-14', '02:30', 'America/New_York');
    expect(instant).toBe(Z('2027-03-14T07:30:00Z'));
    expect(zonedParts(instant, 'America/New_York').time).toBe('03:30');
    // Lord Howe Island moves by 30 minutes.
    expect(zonedParts(zonedEpoch('2027-10-03', '02:15', 'Australia/Lord_Howe'), 'Australia/Lord_Howe').time).toBe('02:45');
  });

  it('takes the earlier instant for a repeated fall-back time', () => {
    // Berlin repeats 02:00–03:00 on 2027-10-31 (CEST then CET).
    expect(zonedEpoch('2027-10-31', '02:30', 'Europe/Berlin')).toBe(Z('2027-10-31T00:30:00Z'));
  });
});

describe('instantOf and comparePoints', () => {
  it('needs a date, a time and a zone for an instant', () => {
    expect(instantOf({ date: '2027-05-01', time: '10:00', tz: 'UTC' })).toBe(Z('2027-05-01T10:00:00Z'));
    expect(instantOf({ date: '2027-05-01', time: '10:00' })).toBeNull();
    expect(instantOf({ date: '2027-05-01', tz: 'UTC' })).toBeNull();
    expect(instantOf({ date: '2027-02-30', time: '10:00', tz: 'UTC' })).toBeNull();
    expect(instantOf({ date: '2027-05-01', time: '10:00', tz: 'Not/AZone' })).toBeNull();
  });

  it('orders an east-to-west arrival with an earlier local time after its departure', () => {
    const dep = { date: '2027-05-01', time: '17:00', tz: 'Asia/Tokyo' };
    const arr = { date: '2027-05-01', time: '05:30', tz: 'Pacific/Honolulu' };
    expect(comparePoints(arr, dep)).toBe(1);
  });

  it('orders across the date line where the arrival date is the day before', () => {
    const dep = { date: '2027-05-02', time: '09:00', tz: 'Pacific/Auckland' };
    const arr = { date: '2027-05-01', time: '23:00', tz: 'America/Los_Angeles' };
    expect(comparePoints(arr, dep)).toBe(1);
  });

  it('compares floating times by wall clock and refuses mixed zoned and floating times', () => {
    expect(comparePoints({ date: '2027-05-01', time: '09:00' }, { date: '2027-05-01', time: '10:00' })).toBe(-1);
    expect(comparePoints({ date: '2027-05-01', time: '09:00', tz: 'UTC' }, { date: '2027-05-01', time: '10:00' })).toBeNull();
  });

  it('decides from dates alone only when no zone offset can reverse them', () => {
    const a = { date: '2027-05-01' };
    expect(comparePoints({ date: '2027-05-02', tz: 'Pacific/Kiritimati' }, { ...a, tz: 'Pacific/Pago_Pago' })).toBeNull();
    expect(comparePoints({ date: '2027-05-03', tz: 'Pacific/Kiritimati' }, { ...a, tz: 'Pacific/Pago_Pago' })).toBeNull();
    expect(comparePoints({ date: '2027-05-04', tz: 'Pacific/Kiritimati' }, { ...a, tz: 'Pacific/Pago_Pago' })).toBe(1);
    expect(comparePoints({ date: '2027-05-02', tz: 'Europe/Paris' }, { ...a, tz: 'Europe/Paris' })).toBe(1);
    expect(comparePoints({ date: '2027-05-02' }, a)).toBe(1);
    expect(comparePoints({ date: '2027-05-01', time: '10:00' }, a)).toBeNull();
  });
});

describe('legs', () => {
  it('measures travel time across zones', () => {
    expect(legDuration(leg('Europe/Lisbon', ['2027-05-01', '10:00'], 'America/New_York', ['2027-05-01', '12:30']))).toBe(450);
    expect(legDuration(leg('Asia/Tokyo', ['2027-05-01', '17:00'], 'Pacific/Honolulu', ['2027-05-01', '05:30']))).toBe(450);
    expect(legDuration(leg('Pacific/Auckland', ['2027-05-02', '09:00'], 'America/Los_Angeles', ['2027-05-01', '23:00']))).toBe(540);
  });

  it('counts the real hours through a DST change', () => {
    // 01:30 CEST to 03:30 CET is three hours, not two.
    expect(legDuration(leg('Europe/Berlin', ['2027-10-31', '01:30'], 'Europe/Berlin', ['2027-10-31', '03:30']))).toBe(180);
    // 01:30 EST to 03:30 EDT is one hour.
    expect(legDuration(leg('America/New_York', ['2027-03-14', '01:30'], 'America/New_York', ['2027-03-14', '03:30']))).toBe(60);
  });

  it('uses wall clocks without zones and gives up on a single missing zone', () => {
    expect(legDuration(leg(undefined, ['2027-05-01', '22:00'], undefined, ['2027-05-02', '06:30']))).toBe(510);
    expect(legDuration(leg('Europe/Lisbon', ['2027-05-01', '10:00'], undefined, ['2027-05-01', '12:30']))).toBeNull();
    expect(legDuration(leg('Europe/Lisbon', ['2027-05-01', ''], 'Europe/Madrid', ['2027-05-01', '12:30']))).toBeNull();
  });

  it('reports the local day offset of the arrival', () => {
    expect(legDayOffset(leg('America/Los_Angeles', ['2027-05-01', '22:00'], 'America/New_York', ['2027-05-02', '06:30']))).toBe(1);
    expect(legDayOffset(leg('Pacific/Auckland', ['2027-05-02', '09:00'], 'America/Los_Angeles', ['2027-05-01', '23:00']))).toBe(-1);
  });

  it('flags arrivals before departures and overlapping connections in absolute time', () => {
    const ok = [
      leg('Europe/Lisbon', ['2027-05-03', '08:00'], 'Europe/Madrid', ['2027-05-03', '10:15']),
      leg('Europe/Madrid', ['2027-05-03', '12:00'], 'America/New_York', ['2027-05-03', '14:30']),
    ];
    expect(legIssues(ok)).toEqual([]);
    expect(legIssues([leg('Asia/Tokyo', ['2027-05-01', '17:00'], 'Pacific/Honolulu', ['2027-05-01', '05:30'])])).toEqual([]);
    const backwards = leg('Europe/Lisbon', ['2027-05-03', '10:00'], 'Europe/Lisbon', ['2027-05-03', '09:00']);
    expect(legIssues([backwards])).toEqual([{ leg: 0, code: 'arrival_before_departure' }]);
    const tight = [ok[0], leg('Europe/Madrid', ['2027-05-03', '10:00'], 'America/New_York', ['2027-05-03', '14:30'])];
    expect(legIssues(tight)).toEqual([{ leg: 1, code: 'departure_before_previous_arrival' }]);
  });
});

describe('ranges and labels', () => {
  it('flags a booking that ends before it starts', () => {
    expect(rangeIssue({ date: '2027-05-02', time: '10:00' }, { date: '2027-05-01', time: '10:00' })).toBe('end_before_start');
    expect(rangeIssue({ date: '2027-05-01', time: '10:00' }, { date: '2027-05-01', time: '11:00' })).toBeNull();
    expect(rangeIssue({ date: '2027-05-01' }, undefined)).toBeNull();
    expect(minutesBetween({ date: '2027-05-01', time: '10:00', tz: 'UTC' }, { date: '2027-05-01', time: '12:00', tz: 'Europe/Paris' })).toBe(0);
  });

  it('names zone offsets per date', () => {
    expect(zoneLabel('Asia/Tokyo', Z('2027-05-01T00:00:00Z'))).toBe('GMT+9');
    expect(zoneLabel('Nope/Zone')).toBe('');
    expect(pointZoneLabel({ date: '2027-01-15', time: '12:00', tz: 'Europe/Lisbon' })).toBe('GMT');
    expect(pointZoneLabel({ date: '2027-07-15', time: '12:00', tz: 'Europe/Lisbon' })).toBe('GMT+1');
    expect(pointZoneLabel({ date: '2027-07-15' })).toBe('');
  });
});
