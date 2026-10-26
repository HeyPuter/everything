import { describe, expect, it } from 'vitest';
import { tripSpan, weekDates, weekPlan } from '../../src/views/week/model.js';

const ME = '00000000-0000-4000-8000-000000000001';
const BOB = '00000000-0000-4000-8000-000000000002';
const ref = (s) => ({ w: 'trips-abcdefghij', s, k: 'trip' });
const day = (id, date, order) => ({ id, date, order });

describe('weekDates', () => {
  it('starts on the preferred weekday', () => {
    expect(weekDates('2027-05-12', 1)).toEqual(['2027-05-10', '2027-05-11', '2027-05-12', '2027-05-13', '2027-05-14', '2027-05-15', '2027-05-16']);
    expect(weekDates('2027-05-12', 0)[0]).toBe('2027-05-09');
    expect(weekDates('2027-05-09', 1)[0]).toBe('2027-05-03');
    expect(weekDates('2027-05-15', 6)[0]).toBe('2027-05-15');
    expect(weekDates('2026-12-30', 1)).toContain('2027-01-03');
  });
});

describe('weekPlan', () => {
  const lisbon = {
    entry: { ref: ref('0000000000000001'), title: 'Index title', start: '2027-05-01', end: '2027-05-02' },
    data: {
      meta: { title: 'Lisbon', start: '2027-05-11', end: '2027-05-14' },
      day: [day('d1', '2027-05-11', 'a0'), day('d2', '2027-05-12', 'a1'), day('d3', '2027-05-13', 'a2'), day('d4', '2027-05-14', 'a3')],
      place: [{ id: 'p1', name: 'Belém Tower' }, { id: 'p2', name: 'Alfama' }],
      visit: [{ id: 'v1', dayId: 'd2', placeId: 'p1', start: '15:00', order: 'a1' }, { id: 'v2', dayId: 'd2', placeId: 'p2', order: 'a0' }, { id: 'v3', dayId: 'd2', title: 'Lunch', start: '12:30', order: 'a2' }],
      res: [
        { id: 'r1', type: 'flight', status: 'confirmed', title: '', legs: [{ from: { code: 'BER', tz: 'Europe/Berlin' }, to: { code: 'LIS', tz: 'Europe/Lisbon' }, dep: { date: '2027-05-11', time: '09:10' }, arr: { date: '2027-05-11', time: '11:20' } }] },
        { id: 'r2', type: 'lodging', status: 'confirmed', title: 'Hotel Baixa', start: { date: '2027-05-11', time: '15:00', tz: 'Europe/Lisbon' }, end: { date: '2027-05-14', time: '11:00', tz: 'Europe/Lisbon' }, stay: { fromDayId: 'd1', toDayId: 'd4' } },
        { id: 'r3', type: 'tour', status: 'cancelled', title: 'Gone', start: { date: '2027-05-12', time: '10:00', tz: 'Europe/Lisbon' } },
      ],
      todo: [{ id: 't1', name: 'Buy Viva card', due: '2027-05-12' }, { id: 't2', name: 'Bob task', due: '2027-05-12', who: BOB }, { id: 't3', name: 'Done', due: '2027-05-12', done: true }],
      listMeta: [],
    },
  };
  const porto = { entry: { ref: ref('0000000000000002'), title: 'Porto', start: '2027-05-14', end: '2027-05-18' }, data: null };
  const later = { entry: { ref: ref('0000000000000003'), title: 'Madeira', start: '2027-06-01', end: '2027-06-08' }, data: null };
  const archived = { entry: { ref: ref('0000000000000004'), title: 'Old', start: '2027-05-10', end: '2027-05-12' }, data: { meta: { title: 'Old', start: '2027-05-10', end: '2027-05-12', archived: true } } };
  const undated = { entry: { ref: ref('0000000000000005'), title: 'Someday', start: null, end: null }, data: { meta: { title: 'Someday' } } };
  const dates = weekDates('2027-05-12', 1);
  const plan = weekPlan([porto, lisbon, later, archived, undated], dates, { uid: ME, today: '2027-05-12' });

  it('places trips on their days with a day number and a colour, preferring the replica dates', () => {
    expect(tripSpan(lisbon)).toMatchObject({ start: '2027-05-11', end: '2027-05-14', title: 'Lisbon' });
    expect(plan.trips.map((trip) => trip.title)).toEqual(['Lisbon', 'Porto']);
    expect(plan.days.map((entry) => entry.trips.map((trip) => trip.title))).toEqual([[], ['Lisbon'], ['Lisbon'], ['Lisbon'], ['Lisbon', 'Porto'], ['Porto'], ['Porto']]);
    expect(plan.days[2]).toMatchObject({ date: '2027-05-12', today: true });
    expect(plan.days[2].trips[0]).toMatchObject({ dayNumber: 2, dayCount: 4, color: 1, cached: true });
    expect(plan.days[4].trips[1]).toMatchObject({ title: 'Porto', color: 2, cached: false, items: [] });
    expect(plan.missing.map((trip) => trip.title)).toEqual(['Porto']);
    expect(plan.next).toMatchObject({ title: 'Madeira', start: '2027-06-01' });
  });

  it('lists timed stops, bookings and my due to-dos in time order', () => {
    const items = plan.days[2].trips[0].items;
    expect(items.map((item) => [item.kind, item.time, item.label])).toEqual([['visit', '12:30', 'Lunch'], ['visit', '15:00', 'Belém Tower'], ['todo', null, 'Buy Viva card']]);
    expect(plan.days[2].trips[0].untimed).toBe(1);
    const first = plan.days[1].trips[0].items;
    expect(first.map((item) => [item.kind, item.time, item.label, item.phase])).toEqual([['booking', '09:10', 'BER → LIS', 'single'], ['booking', '15:00', 'Hotel Baixa', 'checkin']]);
    expect(plan.days[4].trips[0].items.map((item) => item.phase)).toEqual(['checkout']);
  });

  it('shows an empty week with the next trip', () => {
    const empty = weekPlan([later], weekDates('2027-05-12', 1), { uid: ME, today: '2027-05-12' });
    expect(empty.trips).toEqual([]);
    expect(empty.next.title).toBe('Madeira');
  });
});

describe('week view', () => {
  it('mounts from replicas and moves between weeks', async () => {
    const { mount } = await import('../../src/views/week/index.js');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).format(new Date());
    const entry = { ref: ref('0000000000000009'), title: 'Now trip', start: today, end: today };
    const record = { rev: 1, confirmed: { 'meta:meta': { id: 'meta', title: 'Now trip', start: today, end: today } }, pending: [] };
    const personal = { spaces: { list: async () => [entry] }, subscribe: () => () => {} };
    const db = { get: async () => record, close() {} };
    const container = document.createElement('div');
    document.body.append(container);
    const cleanup = await mount(container, { personal, account: { uuid: ME }, session: { db } });
    expect(container.querySelectorAll('.week-day')).toHaveLength(7);
    expect(container.querySelector('.week-day.is-today .week-trip-title').textContent).toBe('Now trip');
    container.querySelector('button[aria-label="Next week"]').click();
    expect(container.querySelector('.week-day.is-today')).toBeNull();
    cleanup();
  });
});
