// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../../src/lib/timeline/index.js';
import {
  clearablePatches, createClock, defaultDwell, legsByStop, openDuring, openRanges, scheduleDay, schedulePatches, visitDwell,
} from '../../src/lib/schedule/index.js';

const PARIS = 'Europe/Paris';
const ref = (key) => { const [t, id] = key.split(':'); return t === 'stay' ? { t: 'res', id, stay: true } : { t, id }; };
const leg = (from, to, minutes, extra = {}) => ({ from: ref(from), to: ref(to), mode: 'walk', distance: minutes * 80, duration: minutes * 60, estimated: false, ...extra });
const visit = (id, dayId, order, extra = {}) => ({ id, dayId, order, placeId: null, title: id, ...extra });
const place = (id, cat, tz = PARIS, extra = {}) => ({ id, name: id, cat, tz, lat: 48.85, lng: 2.35, ...extra });

function setup({ days, visits = [], notes = [], reservations = [], places = [] }) {
  const timeline = buildTimeline({ days, visits, notes, reservations });
  const byId = new Map(places.map((item) => [item.id, item]));
  return (dayId, options = {}) => scheduleDay({ entry: timeline.byDay.get(dayId), place: (id) => byId.get(id) ?? null, ...options });
}
const times = (day) => day.items.filter((item) => item.startWall).map((item) => [item.id, item.startWall?.time ?? null, item.endWall?.time ?? null]);
const codes = (day, id) => day.items.find((item) => item.id === id).warnings.map((entry) => entry.code);
const item = (day, id) => day.items.find((entry) => entry.id === id);

describe('dwell', () => {
  it('prefers the visit dwell, then its span, then the category default', () => {
    expect(visitDwell({ dwell: 45, start: '10:00', end: '13:00' }, place('p', 'beach'))).toEqual({ minutes: 45, source: 'visit' });
    expect(visitDwell({ start: '10:00', end: '13:00' }, place('p', 'beach'))).toEqual({ minutes: 180, source: 'times' });
    expect(visitDwell({ start: '10:00', end: '09:00' }, place('p', 'restaurant'))).toEqual({ minutes: 90, source: 'default' });
    expect(visitDwell({ start: '10:00', end: '13:00', endDayId: 'd2' }, null)).toEqual({ minutes: 60, source: 'default' });
    expect(defaultDwell(place('p', '5000000000000001'))).toBe(60);
    expect(defaultDwell(null)).toBe(60);
  });
});

describe('clock', () => {
  it('reads times in their zone on dated days and floats on undated days', () => {
    const dated = createClock('2026-06-15');
    expect(dated.at('09:00', PARIS)).toBe(Date.UTC(2026, 5, 15, 7));
    expect(dated.at('09:00', null)).toBe(Date.UTC(2026, 5, 15, 9));
    expect(dated.wall(Date.UTC(2026, 5, 15, 22, 30), PARIS)).toEqual({ date: '2026-06-16', time: '00:30', offset: 1 });
    const floating = createClock(null);
    expect(floating.at('09:00', PARIS)).toBe(floating.at('09:00', 'Asia/Tokyo'));
    expect(floating.wall(floating.at('23:30', PARIS) + 3_600_000, PARIS)).toMatchObject({ date: null, time: '00:30', offset: 1 });
  });
  it('moves times in a DST gap forward', () => {
    const clock = createClock('2026-03-29');
    expect(clock.wall(clock.at('02:30', PARIS), PARIS).time).toBe('03:30');
    expect(clock.midnight(PARIS, 1) - clock.midnight(PARIS)).toBe(23 * 3_600_000);
  });
});

describe('opening hours', () => {
  const week = { mo: [], tu: ['09:00-12:00', '14:00-18:00'], we: ['18:00-02:00'], th: ['10:00-24:00'], fr: ['00:00-03:00'], sa: [], su: [] };
  it('checks whole visits against ranges, overnight ones included', () => {
    expect(openDuring(week, '2026-06-16', 9 * 60, 11 * 60)).toEqual({ open: true, opens: null });
    expect(openDuring(week, '2026-06-16', 11 * 60, 13 * 60)).toEqual({ open: false, opens: 14 * 60 });
    expect(openDuring(week, '2026-06-16', 17 * 60, 19 * 60)).toEqual({ open: false, opens: null });
    expect(openDuring(week, '2026-06-17', 23 * 60, 25 * 60)).toEqual({ open: true, opens: null });
    // Wednesday's late opening still covers early Thursday.
    expect(openDuring(week, '2026-06-18', 60, 90).open).toBe(true);
    // Thursday until midnight runs into Friday's early hours.
    expect(openDuring(week, '2026-06-18', 23 * 60, 26 * 60).open).toBe(true);
    expect(openDuring(week, '2026-06-15', 600, 660)).toEqual({ open: false, opens: null });
    expect(openDuring(null, '2026-06-15', 600, 660).open).toBeNull();
    expect(openDuring(week, null, 600, 660).open).toBeNull();
    expect(openRanges(week, '2026-06-18')).toEqual([[-360, 120], [600, 1440 + 180]]);
  });
});

describe('scheduleDay', () => {
  const day = { id: 'd1', order: 'a', date: '2026-06-15' };
  const places = [place('pa', 'attraction'), place('pb', 'restaurant'), place('pc', '5000000000000001'), place('hotel', 'hotel')];

  it('flows untimed visits from the day start with category dwell and travel, rounding starts to 5 minutes', () => {
    const run = setup({ days: [day], places, visits: [visit('v1', 'd1', 'a', { placeId: 'pa' }), visit('v2', 'd1', 'b', { placeId: 'pb' }), visit('v3', 'd1', 'c', { placeId: 'pc' })] });
    const result = run('d1', { legs: [leg('visit:v1', 'visit:v2', 12), leg('visit:v2', 'visit:v3', 7)] });
    expect(times(result)).toEqual([['v1', '09:00', '10:30'], ['v2', '10:45', '12:15'], ['v3', '12:25', '13:25']]);
    expect(item(result, 'v2')).toMatchObject({ flexible: true, wait: 3, travel: { minutes: 12, mode: 'walk', estimated: false } });
    expect(result.leave).toBeNull();
    expect(result.warnings).toEqual([]);
    expect(schedulePatches(result)).toEqual([
      { t: 'visit', id: 'v1', set: { start: '09:00', end: '10:30' } },
      { t: 'visit', id: 'v2', set: { start: '10:45', end: '12:15' } },
      { t: 'visit', id: 'v3', set: { start: '12:25', end: '13:25' } },
    ]);
  });

  it('leaves from the morning stay at the start time and ends at the night stay', () => {
    const hotel = { id: 'h1', type: 'lodging', title: 'Hotel', status: 'confirmed', placeId: 'hotel', start: { date: '2026-06-14', tz: PARIS }, end: { date: '2026-06-16' } };
    const run = setup({ days: [day], places, reservations: [hotel], visits: [visit('v1', 'd1', 'a', { placeId: 'pa' })] });
    const result = run('d1', { start: '08:30', stays: { wake: hotel, sleep: hotel }, legs: [leg('stay:h1', 'visit:v1', 20), leg('visit:v1', 'stay:h1', 15)] });
    expect(result.leave).toMatchObject({ wall: { time: '08:30' }, res: hotel, travel: { minutes: 20 } });
    expect(times(result)).toEqual([['v1', '08:50', '10:20']]);
    expect(result.back).toMatchObject({ wall: { time: '10:35' }, res: hotel });
  });

  it('works back from a fixed first stop to the time to leave', () => {
    const hotel = { id: 'h1', type: 'lodging', title: 'Hotel', status: 'confirmed', placeId: 'hotel', start: { date: '2026-06-14' }, end: { date: '2026-06-16' } };
    const run = setup({ days: [day], places, reservations: [hotel], visits: [visit('v1', 'd1', 'a', { placeId: 'pa', start: '10:00' })] });
    const result = run('d1', { stays: { wake: hotel, sleep: null }, legs: [leg('stay:h1', 'visit:v1', 25)] });
    expect(result.leave.wall.time).toBe('09:35');
  });

  it('keeps pinned visits as anchors in auto mode and timed visits in check mode', () => {
    const visits = [
      visit('v1', 'd1', 'a', { start: '10:00', dwell: 90 }),
      visit('v2', 'd1', 'b', { start: '13:00', dwell: 60, pinned: true }),
      visit('v3', 'd1', 'c', { start: '15:00', end: '15:20', dwell: 30 }),
    ];
    const run = setup({ days: [day], visits });
    const auto = run('d1', { auto: true });
    expect(times(auto)).toEqual([['v1', '09:00', '10:30'], ['v2', '13:00', '14:00'], ['v3', '14:00', '14:30']]);
    expect(item(auto, 'v2')).toMatchObject({ fixed: true, pinned: true, wait: 150 });
    expect(schedulePatches(auto)).toEqual([
      { t: 'visit', id: 'v1', set: { start: '09:00', end: '10:30' } },
      { t: 'visit', id: 'v3', set: { start: '14:00', end: '14:30' } },
    ]);
    const check = run('d1');
    expect(times(check)).toEqual([['v1', '10:00', '11:30'], ['v2', '13:00', '14:00'], ['v3', '15:00', '15:20']]);
    expect(check.items.every((entry) => entry.fixed && !entry.warnings.length)).toBe(true);
    expect(schedulePatches(check)).toEqual([]);
  });

  it('anchors on bookings with time to get to the station and out after arriving', () => {
    const train = {
      id: 't1', type: 'train', title: 'To Lyon', status: 'confirmed', dayPos: { d1: 'am' },
      legs: [{ from: { name: 'Paris', tz: PARIS }, to: { name: 'Lyon', tz: PARIS }, dep: { date: '2026-06-15', time: '12:00' }, arr: { date: '2026-06-15', time: '14:00' } }],
    };
    const visits = [visit('v1', 'd1', 'a', { dwell: 120 }), visit('v2', 'd1', 'b', { dwell: 60 })];
    const legs = [leg('visit:v1', 'res:t1', 20), leg('res:t1', 'visit:v2', 10)];
    const run = setup({ days: [day], visits, reservations: [train] });
    const fits = run('d1', { legs });
    expect(times(fits)).toEqual([['v1', '09:00', '11:00'], ['t1', '12:00', '14:00'], ['v2', '14:15', '15:15']]);
    expect(fits.items.flatMap((entry) => entry.warnings)).toEqual([]);
    expect(item(fits, 't1')).toMatchObject({ fixed: true, pre: 15, post: 5, wait: 25 });
    const late = setup({ days: [day], visits: [visit('v1', 'd1', 'a', { dwell: 180 }), visits[1]], reservations: [train] })('d1', { legs });
    expect(item(late, 't1').warnings).toEqual([{ code: 'late', minutes: 35 }]);
  });

  it('warns about overlaps, short travel gaps and ends before starts', () => {
    const overlap = setup({ days: [day], visits: [visit('v1', 'd1', 'a', { start: '10:00', end: '12:00' }), visit('v2', 'd1', 'b', { start: '11:30' })] })('d1');
    expect(item(overlap, 'v2').warnings).toEqual([{ code: 'overlap', with: 'visit:v1' }]);
    const gap = setup({ days: [day], visits: [visit('v1', 'd1', 'a', { start: '10:00', end: '11:00' }), visit('v2', 'd1', 'b', { start: '11:10' })] })('d1', { legs: [leg('visit:v1', 'visit:v2', 30, { estimated: true })] });
    expect(item(gap, 'v2').warnings).toEqual([{ code: 'travel', needed: 30, available: 10, estimated: true }]);
    const small = setup({ days: [day], visits: [visit('v1', 'd1', 'a', { start: '10:00', end: '11:00' }), visit('v2', 'd1', 'b', { start: '11:10' })] })('d1', { legs: [leg('visit:v1', 'visit:v2', 14)] });
    expect(item(small, 'v2').warnings).toEqual([]);
    const reversed = setup({ days: [day], visits: [visit('v1', 'd1', 'a', { start: '14:00', end: '13:00', dwell: 30 })] })('d1');
    expect(codes(reversed, 'v1')).toEqual(['endBeforeStart']);
    expect(times(reversed)).toEqual([['v1', '14:00', '14:30']]);
  });

  it('waits for opening time and warns when a place is closed', () => {
    const museum = place('museum', 'attraction', PARIS, { hours: { week: { mo: [], tu: ['10:00-18:00'], we: ['10:00-18:00'], th: ['10:00-18:00'], fr: ['10:00-18:00'], sa: ['10:00-18:00'], su: ['10:00-18:00'] } } });
    const lunch = place('lunch', 'restaurant', PARIS, { hours: { week: { tu: ['09:00-12:00', '14:00-18:00'] } } });
    const hours = (spot) => spot.hours ?? null;
    const monday = setup({ days: [day], places: [museum], visits: [visit('v1', 'd1', 'a', { placeId: 'museum' })] })('d1', { hours });
    expect(item(monday, 'v1').warnings).toEqual([{ code: 'closed', allDay: true }]);
    const tuesday = { id: 'd2', order: 'b', date: '2026-06-16' };
    const run = setup({ days: [tuesday], places: [museum, lunch], visits: [
      visit('v1', 'd2', 'a', { placeId: 'museum' }), visit('v2', 'd2', 'b', { placeId: 'museum', start: '17:00' }), visit('v3', 'd2', 'c', { placeId: 'lunch' }),
    ] });
    const result = run('d2', { hours });
    expect(times(result)[0]).toEqual(['v1', '10:00', '11:30']);
    expect(item(result, 'v1')).toMatchObject({ wait: 60, warnings: [] });
    expect(item(result, 'v2').warnings).toEqual([{ code: 'closed', allDay: false }]);
    // After the 17:00 visit the restaurant is closed for the evening: no later opening that day.
    expect(codes(result, 'v3')).toEqual(['closed']);
    const midday = setup({ days: [tuesday], places: [lunch], visits: [visit('v1', 'd2', 'a', { placeId: 'lunch', dwell: 120 })] })('d2', { hours, start: '11:00' });
    expect(times(midday)).toEqual([['v1', '14:00', '16:00']]);
    const hotel = { id: 'h1', type: 'lodging', title: 'Hotel', status: 'confirmed', start: { date: '2026-06-15', tz: PARIS }, end: { date: '2026-06-17' } };
    const later = run('d2', { hours, stays: { wake: hotel }, legs: [leg('stay:h1', 'visit:v1', 20)] });
    expect(later.leave.wall.time).toBe('09:40');
    expect(item(later, 'v1')).toMatchObject({ wait: 0, startWall: { time: '10:00' } });
  });

  it('flags a day that runs past its end and skips patches after midnight', () => {
    const visits = [visit('v1', 'd1', 'a', { dwell: 120 }), visit('v2', 'd1', 'b', { dwell: 120, end: '23:00' }), visit('v3', 'd1', 'c', { dwell: 120 })];
    const run = setup({ days: [day], visits });
    const result = run('d1', { start: '20:00', auto: true });
    expect(times(result)).toEqual([['v1', '20:00', '22:00'], ['v2', '22:00', '00:00'], ['v3', '00:00', '02:00']]);
    expect(codes(result, 'v2')).toEqual([]);
    expect(codes(result, 'v3')).toEqual(['overrun']);
    expect(result.warnings).toEqual([{ code: 'overrun', until: null }]);
    expect(schedulePatches(result)).toEqual([
      { t: 'visit', id: 'v1', set: { start: '20:00', end: '22:00' } },
      { t: 'visit', id: 'v2', set: { start: '22:00' }, unset: ['end'] },
    ]);
    const early = run('d1', { start: '18:00', end: '21:30', auto: true });
    expect(codes(early, 'v2')).toEqual(['overrun']);
    expect(early.warnings).toEqual([{ code: 'overrun', until: '21:30' }]);
  });

  it('warns when the night stay is reached after its latest check-in', () => {
    const inn = { id: 'h2', type: 'lodging', title: 'Inn', status: 'confirmed', start: { date: '2026-06-15', tz: PARIS }, end: { date: '2026-06-16' }, stay: { checkInUntil: '18:00' } };
    const run = setup({ days: [day], reservations: [inn], visits: [visit('v1', 'd1', 'a', { start: '17:00', end: '17:50' })] });
    expect(run('d1', { stays: { sleep: inn }, legs: [leg('visit:v1', 'stay:h2', 5)] }).warnings).toEqual([]);
    expect(run('d1', { stays: { sleep: inn }, legs: [leg('visit:v1', 'stay:h2', 20)] }).warnings).toEqual([{ code: 'checkin', res: inn, until: '18:00' }]);
  });

  it('times a visit by its booking and treats the booking as the same stop', () => {
    const dinner = { id: 'r1', type: 'restaurant', title: 'Dinner', status: 'confirmed', placeId: 'pb', start: { date: '2026-06-15', time: '19:30', tz: PARIS }, end: { date: '2026-06-15', time: '21:00', tz: PARIS } };
    const run = setup({ days: [day], places, reservations: [dinner], visits: [visit('v1', 'd1', 'a', { placeId: 'pa' }), visit('v2', 'd1', 'b', { placeId: 'pb' })] });
    const result = run('d1', { auto: true });
    expect(times(result)).toEqual([['v1', '09:00', '10:30'], ['v2', '19:30', '21:00']]);
    expect(item(result, 'v2')).toMatchObject({ fixed: true, booking: dinner });
    expect(result.items.some((entry) => entry.kind === 'res')).toBe(false);
    expect(schedulePatches(result).map((patch) => patch.id)).toEqual(['v1']);
  });

  it('skips notes and cancelled bookings, and treats rentals as a short hand-over', () => {
    const car = { id: 'c1', type: 'car', title: 'Car', status: 'confirmed', dayPos: { d1: 'a5' }, legs: [{ from: { tz: PARIS }, to: { tz: PARIS }, dep: { date: '2026-06-15', time: '10:00' }, arr: { date: '2026-06-15', time: '18:00' } }] };
    const gone = { id: 'x1', type: 'tour', title: 'Gone', status: 'cancelled', start: { date: '2026-06-15', time: '09:30' } };
    const run = setup({
      days: [day], reservations: [car, gone], notes: [{ id: 'n1', dayId: 'd1', order: 'a0', title: 'Note', time: '09:15' }],
      visits: [visit('v1', 'd1', 'b', { dwell: 30 })],
    });
    const result = run('d1', { start: '09:00' });
    expect(times(result)).toEqual([['c1', '10:00', '10:15'], ['v1', '10:15', '10:45']]);
    expect(result.items.map((entry) => entry.id)).toEqual(['c1', 'v1']);
  });

  it('measures travel across time zones in real time', () => {
    const chicago = place('chi', 'attraction', 'America/Chicago');
    const indy = place('ind', 'attraction', 'America/Indiana/Indianapolis');
    const july = { id: 'j1', order: 'a', date: '2026-07-01' };
    const visits = [visit('v1', 'j1', 'a', { placeId: 'chi', start: '10:00', dwell: 60, pinned: true }), visit('v2', 'j1', 'b', { placeId: 'ind', start: '13:30' })];
    const run = setup({ days: [july], places: [chicago, indy], visits });
    const legs = [leg('visit:v1', 'visit:v2', 180, { mode: 'drive' })];
    // 11:00 in Chicago plus three hours is 15:00 in Indianapolis, an hour ahead.
    expect(item(run('j1', { legs }), 'v2').warnings).toEqual([{ code: 'travel', needed: 180, available: 90, estimated: false }]);
    const auto = run('j1', { legs, auto: true });
    expect(item(auto, 'v2').startWall).toEqual({ date: '2026-07-01', time: '15:00', offset: 0 });
  });

  it('follows a flight west across the date line into local time', () => {
    const tokyo = place('tyo', 'attraction', 'Asia/Tokyo');
    const honolulu = place('hnl', 'beach', 'Pacific/Honolulu');
    const date = { id: 'x', order: 'a', date: '2026-06-10' };
    const flight = {
      id: 'f1', type: 'flight', title: 'HND-HNL', status: 'confirmed', dayPos: { x: 'am' },
      legs: [{ from: { code: 'HND', tz: 'Asia/Tokyo' }, to: { code: 'HNL', tz: 'Pacific/Honolulu' }, dep: { date: '2026-06-10', time: '21:00' }, arr: { date: '2026-06-10', time: '09:00' } }],
    };
    const run = setup({ days: [date], places: [tokyo, honolulu], reservations: [flight], visits: [visit('v1', 'x', 'a', { placeId: 'tyo', start: '17:00', dwell: 60 }), visit('v2', 'x', 'b', { placeId: 'hnl' })] });
    const result = run('x', { legs: [leg('visit:v1', 'res:f1', 60), leg('res:f1', 'visit:v2', 40)] });
    expect(result.items.flatMap((entry) => entry.warnings)).toEqual([]);
    expect(item(result, 'f1').end - item(result, 'f1').start).toBe(7 * 3_600_000);
    expect(item(result, 'v2').startWall).toEqual({ date: '2026-06-10', time: '10:10', offset: 0 });
    expect(times(result).at(-1)).toEqual(['v2', '10:10', '13:10']);
  });

  it('keeps an arrival dated the day before its departure apart from end-before-start', () => {
    const date = { id: 'x', order: 'a', date: '2026-06-11' };
    const flight = {
      id: 'f2', type: 'flight', title: 'Back a day', status: 'confirmed',
      legs: [{ from: { tz: 'Asia/Tokyo' }, to: { tz: 'Pacific/Honolulu' }, dep: { date: '2026-06-11', time: '01:00' }, arr: { date: '2026-06-10', time: '13:00' } }],
    };
    const run = setup({ days: [date], reservations: [flight], visits: [visit('v1', 'x', 'b', { dwell: 60 })] });
    const result = run('x');
    expect(codes(result, 'f2')).toEqual([]);
    expect(item(result, 'f2').endWall).toEqual({ date: '2026-06-10', time: '13:00', offset: -1 });
    expect(item(result, 'v1').startWall).toMatchObject({ date: '2026-06-10', offset: -1 });
    expect(schedulePatches({ ...result, auto: true })).toEqual([]);
  });

  it('counts real minutes through a spring-forward night', () => {
    const date = { id: 's', order: 'a', date: '2026-03-29' };
    const run = setup({ days: [date], places: [place('a', 'bar'), place('b', 'bar')], visits: [visit('v1', 's', 'a', { placeId: 'a', dwell: 120 }), visit('v2', 's', 'b', { placeId: 'b', dwell: 30 })] });
    const result = run('s', { start: '01:00', legs: [leg('visit:v1', 'visit:v2', 10)] });
    expect(times(result)).toEqual([['v1', '01:00', '04:00'], ['v2', '04:10', '04:40']]);
    const gap = setup({ days: [date], places: [place('a', 'bar')], visits: [visit('v1', 's', 'a', { placeId: 'a', start: '02:30', dwell: 30 })] })('s');
    expect(times(gap)).toEqual([['v1', '03:30', '04:00']]);
  });

  it('counts real minutes through a fall-back night', () => {
    const date = { id: 'f', order: 'a', date: '2026-11-01' };
    const ny = 'America/New_York';
    const run = setup({ days: [date], places: [place('a', 'bar', ny), place('b', 'bar', ny)], visits: [visit('v1', 'f', 'a', { placeId: 'a', dwell: 120 }), visit('v2', 'f', 'b', { placeId: 'b', dwell: 30 })] });
    const result = run('f', { start: '00:30', legs: [leg('visit:v1', 'visit:v2', 15)] });
    expect(times(result)).toEqual([['v1', '00:30', '01:30'], ['v2', '01:45', '02:15']]);
    expect(item(result, 'v1').end - item(result, 'v1').start).toBe(2 * 3_600_000);
  });

  it('floats on undated days, ignoring zones', () => {
    const undated = { id: 'u', order: 'a', date: null };
    const run = setup({ days: [undated], places: [place('a', 'bar', 'Asia/Tokyo'), place('b', 'bar', PARIS)], visits: [visit('v1', 'u', 'a', { placeId: 'a', start: '10:00', dwell: 60 }), visit('v2', 'u', 'b', { placeId: 'b', dwell: 60 })] });
    const result = run('u', { legs: [leg('visit:v1', 'visit:v2', 30)] });
    expect(result.dated).toBe(false);
    expect(times(result)).toEqual([['v1', '10:00', '11:00'], ['v2', '11:30', '12:30']]);
    expect(item(result, 'v2').startWall.date).toBeNull();
  });

  it('blocks the rest of the day after an overnight departure and starts the next day at the arrival', () => {
    const days = [{ id: 'd1', order: 'a', date: '2026-05-01' }, { id: 'd2', order: 'b', date: '2026-05-02' }];
    const flight = {
      id: 'f3', type: 'flight', title: 'Overnight', status: 'confirmed',
      legs: [{ from: { tz: 'America/New_York' }, to: { tz: 'Europe/London' }, dep: { date: '2026-05-01', time: '22:00' }, arr: { date: '2026-05-02', time: '10:00' } }],
    };
    const hotel = { id: 'h', type: 'lodging', title: 'Hotel', status: 'confirmed', start: { date: '2026-04-29' }, end: { date: '2026-05-01' } };
    const run = setup({ days, reservations: [flight, hotel], visits: [visit('v1', 'd1', 'a', { start: '23:00' }), visit('v2', 'd2', 'a', { dwell: 60 })] });
    const first = run('d1');
    expect(first.items.map((entry) => entry.id)).toEqual(['f3', 'v1']);
    expect(codes(first, 'v1')).toEqual(['overlap']);
    expect(first.warnings).toEqual([]);
    const second = run('d2', { stays: { wake: hotel }, legs: [leg('res:f3', 'visit:v2', 45)] });
    expect(second.items.map((entry) => entry.id)).toEqual(['f3', 'v2']);
    expect(item(second, 'f3')).toMatchObject({ openStart: true, endWall: { time: '10:00' } });
    expect(times(second)).toEqual([['v2', '11:15', '12:15']]);
    expect(second.leave).toBeNull();
  });

  it('lists clearable visit times, keeping pinned ones', () => {
    const timeline = buildTimeline({ days: [day], visits: [visit('v1', 'd1', 'a', { start: '10:00', end: '11:00' }), visit('v2', 'd1', 'b', { start: '12:00', pinned: true }), visit('v3', 'd1', 'c'), visit('v4', 'd1', 'd', { end: '18:00' })] });
    expect(clearablePatches(timeline.byDay.get('d1'))).toEqual([{ t: 'visit', id: 'v1', unset: ['start', 'end'] }, { t: 'visit', id: 'v4', unset: ['end'] }]);
  });

  it('indexes legs by the stop they reach', () => {
    const map = legsByStop([leg('stay:h', 'visit:a', 5), leg('visit:a', 'res:t', 3), leg('res:t', 'stay:h', 9), { to: { t: 'visit' } }]);
    expect([...map.keys()]).toEqual(['visit:a', 'res:t', 'stay:h']);
  });
});
