// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { applyPatch } from '../../src/shared/operations.js';
import { dayRemovalImpact, shiftPatch, stayDaysPatch } from '../../src/lib/res/shift.js';

const dayId = (n) => `d000000000000${String(n).padStart(3, '0')}`;
const days = Object.freeze(['2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04'].map((date, index) => Object.freeze({ id: dayId(index + 1), order: `a${index}`, date })));
const [d1, d2, d3, d4] = days.map((day) => day.id);
const base = { title: 'R', status: 'confirmed' };

describe('re-dating', () => {
  it('shifts every date of a reservation, legs included', () => {
    const flight = { ...base, type: 'flight', start: { date: '2027-05-31', time: '22:00', tz: 'Europe/Lisbon' }, end: { date: '2027-06-01', time: '06:00' },
      legs: [{ from: {}, to: {}, dep: { date: '2027-05-31', time: '22:00' }, arr: { date: '2027-06-01', time: '06:00' } }] };
    const patch = shiftPatch(flight, 2);
    expect(applyPatch('trip', 'res', flight, patch)).toMatchObject({
      start: { date: '2027-06-02', time: '22:00', tz: 'Europe/Lisbon' }, end: { date: '2027-06-03' },
      legs: [{ dep: { date: '2027-06-02' }, arr: { date: '2027-06-03' } }],
    });
    expect(shiftPatch(flight, 0)).toBeNull();
    expect(shiftPatch({ ...base, type: 'other' }, 3)).toBeNull();
  });

  it('matches stay day ids to dates, and drops them for a partial overlap', () => {
    const hotel = { ...base, type: 'lodging', start: { date: '2027-05-02' }, end: { date: '2027-05-04' }, stay: { checkOut: '11:00' } };
    expect(stayDaysPatch(hotel, days)).toEqual({ set: { stay: { checkOut: '11:00', fromDayId: d2, toDayId: d4 } } });
    expect(stayDaysPatch({ ...hotel, stay: { checkOut: '11:00', fromDayId: d2, toDayId: d4 } }, days)).toBeNull();
    const partial = { ...hotel, end: { date: '2027-05-09' }, stay: { fromDayId: d2, toDayId: d4 } };
    expect(stayDaysPatch(partial, days)).toEqual({ unset: ['stay'] });
    expect(stayDaysPatch({ ...base, type: 'tour' }, days)).toBeNull();
  });
});

describe('deleting a day', () => {
  it('cancels stays that check in or out that day, shortens stays spanning it and unassigns the rest', () => {
    const spanning = { ...base, id: 'r1', type: 'lodging', start: { date: '2027-05-01' }, end: { date: '2027-05-04' }, stay: { fromDayId: d1, toDayId: d4 }, dayPos: { [d2]: 'a1' } };
    const checkIn = { ...base, id: 'r2', type: 'lodging', stay: { fromDayId: d2, toDayId: d3 } };
    const dinner = { ...base, id: 'r3', type: 'restaurant', start: { date: '2027-05-02', time: '20:00' }, dayPos: { [d2]: 'b' } };
    const elsewhere = { ...base, id: 'r4', type: 'tour', start: { date: '2027-05-04' } };
    const cancelled = { ...base, id: 'r5', status: 'cancelled', type: 'lodging', stay: { fromDayId: d2, toDayId: d3 } };
    const impact = dayRemovalImpact([spanning, checkIn, dinner, elsewhere, cancelled], days, d2);
    expect(impact.map((item) => [item.res.id, item.action, item.patch])).toEqual([
      ['r1', 'shorten', { set: { end: { date: '2027-05-03' } }, unset: [`dayPos.${d2}`] }],
      ['r2', 'cancel', { set: { status: 'cancelled' } }],
      ['r3', 'unassign', { unset: [`dayPos.${d2}`] }],
    ]);
  });
});
