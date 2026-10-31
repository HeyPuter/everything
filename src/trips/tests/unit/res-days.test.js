// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { compareEntries, dayForDate, dayStays, entriesByDay, orderAfter, resEntries, staleDayPos, stayDays, unplaced } from '../../src/lib/res/days.js';
import { isOrder } from '../../src/shared/order.js';

const dayId = (n) => `d000000000000${String(n).padStart(3, '0')}`;
const days = Object.freeze(['2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04', '2027-05-05']
  .map((date, index) => Object.freeze({ id: dayId(index + 1), order: `a${index}`, date })));
const [d1, d2, d3, d4, d5] = days.map((day) => day.id);
const undated = Object.freeze([...days, { id: dayId(8), order: 'b0', date: null }, { id: dayId(9), order: 'b1', date: null }]);
let n = 0;
const res = (fields) => ({ id: `r000000000000${String(++n).padStart(3, '0')}`, title: 'R', status: 'confirmed', ...fields });
const leg = (from, dep, to, arr, extra = {}) => ({ from: { code: from[0], tz: from[1] }, to: { code: to[0], tz: to[1] }, dep: { date: dep[0], time: dep[1] }, arr: { date: arr[0], time: arr[1] }, ...extra });
const summary = (entries) => entries.map((entry) => [entry.dayId, entry.phase, entry.name, entry.leg, entry.time]);

describe('bookings on dated days', () => {
  it('places a same-day booking on its date with a local time', () => {
    const dinner = res({ type: 'restaurant', start: { date: '2027-05-02', time: '19:30', tz: 'Europe/Lisbon' } });
    const [entry] = resEntries(dinner, days);
    expect(entry).toMatchObject({ dayId: d2, phase: 'single', name: 'single', time: '19:30', tz: 'Europe/Lisbon', minutes: 1170, instant: Date.parse('2027-05-02T18:30:00Z') });
  });

  it('never clamps dates outside the trip', () => {
    const early = res({ type: 'event', start: { date: '2027-04-20' } });
    const undatedRes = res({ type: 'other' });
    expect(resEntries(early, days)).toEqual([]);
    expect(unplaced([early, undatedRes], days)).toEqual([early, undatedRes]);
  });

  it('labels multi-day phases per type', () => {
    const festival = res({ type: 'event', start: { date: '2027-05-02', time: '18:00' }, end: { date: '2027-05-04', time: '23:00' } });
    expect(summary(resEntries(festival, days))).toEqual([
      [d2, 'start', 'start', null, '18:00'], [d3, 'middle', 'ongoing', null, null], [d4, 'end', 'end', null, '23:00'],
    ]);
    const parking = res({ type: 'parking', start: { date: '2027-05-01', time: '07:00' }, end: { date: '2027-05-03', time: '20:00' } });
    expect(resEntries(parking, days).map((entry) => entry.name)).toEqual(['dropoff', 'parked', 'collect']);
  });

  it('shows a rental car as pickup, active and return', () => {
    const car = res({ type: 'car', legs: [leg(['', 'Europe/Lisbon'], ['2027-05-01', '10:00'], ['', 'Europe/Lisbon'], ['2027-05-04', '18:00'])] });
    expect(summary(resEntries(car, days))).toEqual([
      [d1, 'start', 'pickup', 0, '10:00'], [d2, 'middle', 'active', 0, null], [d3, 'middle', 'active', 0, null], [d4, 'end', 'return', 0, '18:00'],
    ]);
  });

  it('splits an overnight flight into departure and arrival in each local zone', () => {
    const flight = res({ type: 'flight', legs: [leg(['LAX', 'America/Los_Angeles'], ['2027-05-01', '22:00'], ['JFK', 'America/New_York'], ['2027-05-02', '06:30'])] });
    const entries = resEntries(flight, days);
    expect(summary(entries)).toEqual([[d1, 'start', 'depart', 0, '22:00'], [d2, 'end', 'arrive', 0, '06:30']]);
    expect(entries.map((entry) => entry.tz)).toEqual(['America/Los_Angeles', 'America/New_York']);
    expect(entries[1].instant - entries[0].instant).toBe(330 * 60_000);
  });

  it('keeps an east-to-west flight on its departure day with both local times', () => {
    const flight = res({ type: 'flight', legs: [leg(['HND', 'Asia/Tokyo'], ['2027-05-02', '17:00'], ['HNL', 'Pacific/Honolulu'], ['2027-05-02', '05:30'])] });
    expect(resEntries(flight, days)).toMatchObject([{ dayId: d2, phase: 'single', time: '17:00', tz: 'Asia/Tokyo', endTime: '05:30', endTz: 'Pacific/Honolulu' }]);
    const dateLine = res({ type: 'flight', legs: [leg(['AKL', 'Pacific/Auckland'], ['2027-05-03', '09:00'], ['LAX', 'America/Los_Angeles'], ['2027-05-02', '23:00'])] });
    expect(resEntries(dateLine, days)).toMatchObject([{ dayId: d3, phase: 'single', time: '09:00', endTime: '23:00' }]);
  });

  it('gives each leg of a connection its own row and covers layover days', () => {
    const connection = res({ type: 'flight', legs: [
      leg(['LIS', 'Europe/Lisbon'], ['2027-05-03', '08:00'], ['MAD', 'Europe/Madrid'], ['2027-05-03', '10:15']),
      leg(['MAD', 'Europe/Madrid'], ['2027-05-03', '12:00'], ['JFK', 'America/New_York'], ['2027-05-03', '14:30']),
    ] });
    expect(summary(resEntries(connection, days))).toEqual([[d3, 'single', 'single', 0, '08:00'], [d3, 'single', 'single', 1, '12:00']]);
    const layover = res({ type: 'train', legs: [
      leg(['A', 'Europe/Paris'], ['2027-05-01', '09:00'], ['B', 'Europe/Paris'], ['2027-05-01', '12:00']),
      leg(['B', 'Europe/Paris'], ['2027-05-03', '09:00'], ['C', 'Europe/Paris'], ['2027-05-03', '12:00']),
    ] });
    expect(summary(resEntries(layover, days))).toEqual([[d1, 'single', 'single', 0, '09:00'], [d3, 'single', 'single', 1, '09:00'], [d2, 'middle', 'transit', null, null]]);
  });
});

describe('stays', () => {
  const hotel = res({
    type: 'lodging', start: { date: '2027-05-02', tz: 'Europe/Lisbon' }, end: { date: '2027-05-04', tz: 'Europe/Lisbon' },
    stay: { checkInFrom: '15:00', checkInUntil: '22:00', checkOut: '11:00', fromDayId: d2, toDayId: d4 },
  });

  it('shows check-in, every night and check-out by day id', () => {
    expect(summary(resEntries(hotel, days))).toEqual([[d2, 'start', 'checkin', null, '15:00'], [d3, 'middle', 'stay', null, null], [d4, 'end', 'checkout', null, '11:00']]);
    expect(stayDays(hotel, days)).toEqual([d2, d3, d4]);
  });

  it('follows the days, not stale dates, when the trip is re-dated', () => {
    const moved = Object.freeze(days.map((day, index) => ({ ...day, date: `2027-06-0${index + 1}` })));
    expect(resEntries(hotel, moved).map((entry) => entry.dayId)).toEqual([d2, d3, d4]);
  });

  it('falls back to dates when a stay day is gone, and shows a stay that began before the trip as ongoing', () => {
    const orphan = { ...hotel, stay: { ...hotel.stay, fromDayId: dayId(99) } };
    expect(resEntries(orphan, days).map((entry) => entry.name)).toEqual(['checkin', 'stay', 'checkout']);
    const before = res({ type: 'lodging', start: { date: '2027-04-28' }, end: { date: '2027-05-02' }, stay: { checkOut: '10:00' } });
    expect(summary(resEntries(before, days))).toEqual([[d1, 'middle', 'stay', null, null], [d2, 'end', 'checkout', null, '10:00']]);
  });

  it('names where each day starts and ends', () => {
    const second = res({ type: 'lodging', stay: { fromDayId: d4, toDayId: d5 } });
    const cancelled = res({ type: 'lodging', status: 'cancelled', stay: { fromDayId: d1, toDayId: d5 } });
    const list = [hotel, second, cancelled];
    expect(dayStays(list, days, d1)).toEqual({ wake: null, sleep: null });
    expect(dayStays(list, days, d2)).toEqual({ wake: null, sleep: hotel });
    expect(dayStays(list, days, d3)).toEqual({ wake: hotel, sleep: hotel });
    expect(dayStays(list, days, d4)).toEqual({ wake: hotel, sleep: second });
    expect(dayStays(list, days, d5)).toEqual({ wake: second, sleep: null });
  });
});

describe('undated days and positions', () => {
  it('assigns a booking to an undated day through dayPos, one row per leg', () => {
    const train = res({ type: 'train', dayPos: { [dayId(9)]: 'a5', [d1]: 'b0' }, legs: [
      leg(['A', 'Europe/Paris'], ['2027-07-01', '09:00'], ['B', 'Europe/Paris'], ['2027-07-01', '10:00']),
      leg(['B', 'Europe/Paris'], ['2027-07-01', '11:00'], ['C', 'Europe/Paris'], ['2027-07-01', '12:00']),
    ] });
    // The dated day key is a position only: the July date is outside this trip.
    expect(resEntries(train, undated)).toMatchObject([
      { dayId: dayId(9), phase: 'single', leg: 0, explicit: true, pos: 'a5', time: '09:00', endTime: '10:00' },
      { dayId: dayId(9), phase: 'single', leg: 1, explicit: true, pos: 'a5', time: '11:00' },
    ]);
    const tour = res({ type: 'tour', dayPos: { [dayId(8)]: 'a1' } });
    expect(resEntries(tour, undated)).toMatchObject([{ dayId: dayId(8), phase: 'single', time: null }]);
  });

  it('carries the manual position on dated days and drops positions of deleted days', () => {
    const museum = res({ type: 'tour', start: { date: '2027-05-03', time: '10:00' }, dayPos: { [d3]: 'a5', [dayId(77)]: 'a1' } });
    expect(resEntries(museum, days)[0].pos).toBe('a5');
    expect(staleDayPos(museum, days)).toEqual([dayId(77)]);
  });

  it('groups by day, leaves out cancelled bookings and sorts all-day rows first', () => {
    const late = res({ type: 'restaurant', start: { date: '2027-05-03', time: '20:00' } });
    const early = res({ type: 'tour', start: { date: '2027-05-03', time: '09:00' } });
    const allDay = res({ type: 'event', start: { date: '2027-05-03' } });
    const cancelled = res({ type: 'tour', status: 'cancelled', start: { date: '2027-05-03', time: '12:00' } });
    const map = entriesByDay([late, early, allDay, cancelled], days);
    expect(map.get(d3).map((entry) => entry.resId)).toEqual([allDay.id, early.id, late.id]);
    expect(map.get(d1)).toEqual([]);
    expect(entriesByDay([cancelled], days, { includeCancelled: true }).get(d3)).toHaveLength(1);
    const positioned = [{ minutes: 600, pos: 'b', resId: 'x', leg: null }, { minutes: 600, pos: 'a', resId: 'y', leg: null }, { minutes: 600, pos: null, resId: 'a', leg: null }];
    expect([...positioned].sort(compareEntries).map((entry) => entry.resId)).toEqual(['y', 'x', 'a']);
  });

  it('finds days by date and orders after existing keys', () => {
    expect(dayForDate(days, '2027-05-04')).toBe(d4);
    expect(dayForDate(days, '2027-06-01')).toBeNull();
    const key = orderAfter(['a1', 'a5', null, 'a3']);
    expect(isOrder(key) && key > 'a5').toBe(true);
  });
});
