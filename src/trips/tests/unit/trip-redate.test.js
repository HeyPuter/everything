// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { planRedate, targetDays } from '../../worker/ops/trip/domain/redate.js';
import { orderKeys } from '../../src/shared/order.js';
import { dateRange } from '../../src/shared/dates.js';

let n = 0;
const id = () => `d${String(++n).padStart(15, '0')}`;
function datedTrip(start, end) {
  const dates = dateRange(start, end);
  const keys = orderKeys(dates.length);
  return { meta: { title: 'T', currency: 'EUR', start, end }, days: dates.map((date, i) => ({ id: id(), date, order: keys[i] })) };
}
function undatedTrip(count) {
  const keys = orderKeys(count);
  return { meta: { title: 'T', currency: 'EUR', dayCount: count }, days: keys.map((order) => ({ id: id(), date: null, order })) };
}
const ids = (count) => Array.from({ length: count }, id);
const apply = (days, writes) => {
  const map = new Map(days.map((day) => [day.id, { ...day }]));
  for (const write of writes.filter((item) => item.t === 'day')) {
    if (write.del) map.delete(write.id);
    else if (write.put) map.set(write.id, { id: write.id, ...write.put });
    else Object.assign(map.get(write.id), write.set);
  }
  return [...map.values()].sort((a, b) => (a.order < b.order ? -1 : 1));
};

describe('trip.redate planner', () => {
  it('shifts every day with the trip when only the start moves', () => {
    const { meta, days } = datedTrip('2027-05-01', '2027-05-04');
    const { writes, impact } = planRedate({ meta, days, target: { start: '2027-05-10', end: '2027-05-13' } });
    expect(impact).toMatchObject({ removedDays: [], created: 0, moved: 4, delta: 9 });
    expect(apply(days, writes).map((day) => [day.id, day.date])).toEqual(days.map((day, i) => [day.id, `2027-05-${10 + i}`]));
    expect(writes[0]).toEqual({ t: 'meta', id: 'meta', set: { start: '2027-05-10', end: '2027-05-13' } });
  });

  it('keys days by date when the range changes and removes the content of dropped days', () => {
    const { meta, days } = datedTrip('2027-05-01', '2027-05-05');
    const visits = [{ id: id(), dayId: days[0].id }, { id: id(), dayId: days[3].id, endDayId: days[4].id }];
    const notes = [{ id: id(), dayId: days[4].id }];
    const { writes, impact } = planRedate({ meta, days, visits, notes, target: { start: '2027-05-02', end: '2027-05-04' } });
    expect(impact.removedDays.map((day) => day.date)).toEqual(['2027-05-01', '2027-05-05']);
    expect(impact).toMatchObject({ removedVisits: 1, removedNotes: 1, created: 0 });
    expect(writes).toContainEqual({ t: 'visit', id: visits[0].id, del: true });
    expect(writes).toContainEqual({ t: 'visit', id: visits[1].id, unset: ['endDayId'] });
    expect(writes).toContainEqual({ t: 'dayNote', id: notes[0].id, del: true });
    expect(apply(days, writes).map((day) => day.date)).toEqual(['2027-05-02', '2027-05-03', '2027-05-04']);
  });

  it('extends with new days in date order and needs one new id per day', () => {
    const { meta, days } = datedTrip('2027-05-03', '2027-05-04');
    expect(() => planRedate({ meta, days, target: { start: '2027-05-01', end: '2027-05-06' } })).toThrow('invalid_args');
    const { writes, impact } = planRedate({ meta, days, target: { start: '2027-05-01', end: '2027-05-06' }, newIds: ids(4) });
    expect(impact.created).toBe(4);
    const result = apply(days, writes);
    expect(result.map((day) => day.date)).toEqual(['2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04', '2027-05-05', '2027-05-06']);
    expect(result.find((day) => day.date === '2027-05-03').id).toBe(days[0].id);
  });

  it('dates an undated trip in day order and undates a dated one', () => {
    const undated = undatedTrip(3);
    const first = planRedate({ ...undated, target: { start: '2027-01-30', end: '2027-02-02' }, newIds: ids(1) });
    expect(apply(undated.days, first.writes).map((day) => [day.date, undated.days.findIndex((item) => item.id === day.id)]))
      .toEqual([['2027-01-30', 0], ['2027-01-31', 1], ['2027-02-01', 2], ['2027-02-02', -1]]);
    const dated = datedTrip('2027-05-01', '2027-05-04');
    const second = planRedate({ ...dated, target: { start: null, end: null, dayCount: 2 } });
    expect(second.impact.removedDays.map((day) => day.date)).toEqual(['2027-05-03', '2027-05-04']);
    expect(second.writes[0]).toEqual({ t: 'meta', id: 'meta', set: { start: null, end: null, dayCount: 2 } });
    expect(apply(dated.days, second.writes).map((day) => day.date)).toEqual([null, null]);
  });

  it('keeps bookings on their dates or shifts them, remapping day positions and cancelling stays that lose a day', () => {
    const { meta, days } = datedTrip('2027-05-01', '2027-05-04');
    const flight = { id: id(), type: 'flight', title: 'Out', status: 'confirmed', start: { date: '2027-05-02', time: '09:00' },
      legs: [{ from: {}, to: {}, dep: { date: '2027-05-02', time: '09:00' }, arr: { date: '2027-05-02', time: '12:00' } }], dayPos: { [days[1].id]: 'a' } };
    const hotel = { id: id(), type: 'lodging', title: 'Inn', status: 'confirmed', stay: { fromDayId: days[2].id, toDayId: days[3].id } };
    const kept = planRedate({ meta, days, res: [flight, hotel], target: { start: '2027-05-02', end: '2027-05-05' }, bookings: 'keep' });
    // Days moved one day later: the flight's 2 May now sits on the first day; the stay's 4 May end now sits on day three.
    expect(kept.writes).toContainEqual({ t: 'res', id: flight.id, set: { dayPos: { [days[0].id]: 'a' } } });
    expect(kept.writes).toContainEqual({ t: 'res', id: hotel.id, set: { stay: { fromDayId: days[1].id, toDayId: days[2].id } } });
    const shifted = planRedate({ meta, days, res: [flight, hotel], target: { start: '2027-05-02', end: '2027-05-05' }, bookings: 'shift' });
    const write = shifted.writes.find((item) => item.id === flight.id);
    expect(write.set.start).toEqual({ date: '2027-05-03', time: '09:00' });
    expect(write.set.legs[0].arr.date).toBe('2027-05-03');
    expect(write.set.dayPos).toBeUndefined();
    expect(shifted.impact.shifted).toBe(1);
    const shrink = planRedate({ meta, days, res: [hotel], target: { start: '2027-05-01', end: '2027-05-03' } });
    expect(shrink.writes).toContainEqual({ t: 'res', id: hotel.id, set: { status: 'cancelled', stay: { fromDayId: days[2].id } } });
    expect(shrink.impact.cancelled).toEqual([{ id: hotel.id, title: 'Inn' }]);
  });

  it('lays dated stays onto the new days from their dates, through the bookings helpers', () => {
    const { meta, days } = datedTrip('2027-05-01', '2027-05-04');
    // Stale ids (day 1 → day 2) lose to the dates (2 → 3 May).
    const inn = { id: id(), type: 'lodging', title: 'Inn', status: 'confirmed', start: { date: '2027-05-02' }, end: { date: '2027-05-03' },
      stay: { checkOut: '11:00', fromDayId: days[0].id, toDayId: days[1].id } };
    const kept = planRedate({ meta, days, res: [inn], target: { start: '2027-05-01', end: '2027-05-05' }, newIds: ids(1) });
    expect(kept.writes).toContainEqual({ t: 'res', id: inn.id, set: { stay: { checkOut: '11:00', fromDayId: days[1].id, toDayId: days[2].id } } });
    const shifted = planRedate({ meta, days, res: [inn], target: { start: '2027-05-03', end: '2027-05-06' }, bookings: 'shift' });
    const write = shifted.writes.find((item) => item.id === inn.id);
    expect(write.set.start).toEqual({ date: '2027-05-04' });
    expect(write.set.stay).toEqual({ checkOut: '11:00', fromDayId: days[1].id, toDayId: days[2].id });
    expect(shifted.impact).toMatchObject({ shifted: 1, cancelled: [] });
    // Kept on its dates while the trip moves away: the stay falls back to its dates and is cancelled.
    const away = planRedate({ meta, days, res: [inn], target: { start: '2027-05-03', end: '2027-05-06' } });
    expect(away.writes).toContainEqual({ t: 'res', id: inn.id, set: { stay: { checkOut: '11:00' }, status: 'cancelled' } });
    // A stay placed by its dates alone gains day ids and is not cancelled when it leaves the trip.
    const loose = { ...inn, stay: undefined };
    expect(planRedate({ meta, days, res: [loose], target: { start: '2027-05-01', end: '2027-05-04' } }).writes)
      .toContainEqual({ t: 'res', id: inn.id, set: { stay: { fromDayId: days[1].id, toDayId: days[2].id } } });
    expect(planRedate({ meta, days, res: [loose], target: { start: '2027-05-10', end: '2027-05-13' } }).impact.cancelled).toEqual([]);
  });

  it('keeps order keys increasing when days are re-laid', () => {
    const { meta, days } = datedTrip('2027-05-01', '2027-05-03');
    const scrambled = days.map((day, i) => ({ ...day, order: days[2 - i].order }));
    const { writes } = planRedate({ meta, days: scrambled, target: { start: '2027-05-01', end: '2027-05-04' }, newIds: ids(1) });
    const result = apply(scrambled, writes);
    expect(result.map((day) => day.date)).toEqual(['2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04']);
    expect(targetDays({ start: '2027-05-01', end: '2027-05-04' })).toBe(4);
    expect(targetDays({ dayCount: 5 })).toBe(5);
  });
});
