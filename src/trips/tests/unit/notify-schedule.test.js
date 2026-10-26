import { describe, expect, it, vi } from 'vitest';
import { allReminders, dueNow, nextFire, overdueTodos, tripReminders, upcoming } from '../../src/lib/notify/schedule.js';
import { replicaData } from '../../src/lib/notify/replica.js';
import { reminderRows } from '../../src/lib/notify/settings.js';

const ME = '00000000-0000-4000-8000-000000000001';
const BOB = '00000000-0000-4000-8000-000000000002';
const zone = 'Europe/Lisbon';
const ref = { w: 'trips-abcdefghij', s: '0000000000000001', k: 'trip' };
const at = (iso) => Date.parse(iso);
const trip = (data, entry = {}) => ({ entry: { ref, title: 'Lisbon', ...entry }, data: { meta: null, day: [], visit: [], place: [], res: [], todo: [], listMeta: [], ...data } });
const meta = (fields) => ({ id: 'meta', title: 'Lisbon', start: '2027-05-10', end: '2027-05-14', ...fields });
const kinds = (list, kind) => list.filter((item) => item.kind === kind);

describe('trip reminders', () => {
  it('fire at 09:00 local the chosen days before and stay until the end of the first day', () => {
    const list = kinds(tripReminders(trip({ meta: meta({ reminderDays: [7, 0, 1] }) }), { uid: ME, zone, now: at('2027-05-01T00:00:00Z') }), 'trip');
    expect(new Set(list.map((item) => item.fireAt))).toEqual(new Set([at('2027-05-03T08:00:00Z'), at('2027-05-09T08:00:00Z'), at('2027-05-10T08:00:00Z')]));
    for (const item of list) expect(item.until).toBe(at('2027-05-10T23:00:00Z'));
    expect(list[0]).toMatchObject({ tab: 'plan', trip: 'Lisbon', ref });
  });

  it('are listed as they will read when they fire', () => {
    const now = at('2027-05-01T00:00:00Z');
    const list = upcoming(kinds(tripReminders(trip({ meta: meta({ reminderDays: [3, 0] }) }), { uid: ME, zone, now }), 'trip'), { now });
    expect(reminderRows(list, { now, zone }).map((row) => row.body.split(' · ')[0])).toEqual(['Starts in 3 days', 'Starts today']);
  });

  it('keep 09:00 on the wall clock across a DST change', () => {
    const list = kinds(tripReminders(trip({ meta: meta({ start: '2027-03-29', end: '2027-04-02', reminderDays: [1, 3] }) }), { uid: ME, zone }), 'trip');
    expect(new Set(list.map((item) => item.fireAt))).toEqual(new Set([at('2027-03-28T08:00:00Z'), at('2027-03-26T09:00:00Z')]));
  });

  it('change key when the trip is re-dated, and skip archived or undated trips', () => {
    const before = tripReminders(trip({ meta: meta({ reminderDays: [1] }) }), { uid: ME, zone })[0].key;
    const after = tripReminders(trip({ meta: meta({ start: '2027-05-11', reminderDays: [1] }) }), { uid: ME, zone })[0].key;
    expect(after).not.toBe(before);
    expect(tripReminders(trip({ meta: meta({ reminderDays: [1], archived: true }) }), { uid: ME, zone })).toEqual([]);
    expect(kinds(tripReminders(trip({ meta: meta({ start: null, end: null, reminderDays: [1] }) }), { uid: ME, zone }), 'trip')).toEqual([]);
  });
});

describe('booking reminders', () => {
  const flight = { id: 'r000000000000001', type: 'flight', status: 'confirmed', title: '', legs: [
    { from: { code: 'LIS', tz: 'Europe/Lisbon' }, to: { code: 'JFK', tz: 'America/New_York' }, dep: { date: '2027-05-14', time: '11:30' }, arr: { date: '2027-05-14', time: '14:05' }, carrier: 'TP', number: '209' },
    { from: { code: 'JFK', tz: 'America/New_York' }, to: { code: 'BOS', tz: 'America/New_York' }, dep: { date: '2027-05-14', time: '17:00' }, arr: { date: '2027-05-14', time: '18:10' }, carrier: 'B6', number: '1' },
  ] };
  const dinner = { id: 'r000000000000002', type: 'restaurant', status: 'pending', title: 'Dinner', start: { date: '2027-05-11', time: '20:00', tz: 'Europe/Lisbon' } };

  it('fire 3 hours before a flight (first timed leg only) and 1 hour before other timed bookings', () => {
    const list = kinds(tripReminders(trip({ meta: meta({}), res: [flight, dinner] }), { uid: ME, zone }), 'booking');
    expect(list).toHaveLength(2);
    const flightItem = list.find((item) => item.title.includes('TP 209'));
    expect(flightItem.startAt).toBe(at('2027-05-14T10:30:00Z'));
    expect(flightItem.fireAt).toBe(at('2027-05-14T07:30:00Z'));
    expect(flightItem.until).toBe(flightItem.startAt);
    expect(flightItem.tab).toBe('bookings');
    const dinnerItem = list.find((item) => item.title === 'Dinner');
    expect(dinnerItem.fireAt).toBe(at('2027-05-11T18:00:00Z'));
  });

  it('skip cancelled and untimed bookings', () => {
    const list = kinds(tripReminders(trip({ meta: meta({}), res: [{ ...dinner, status: 'cancelled' }, { ...dinner, id: 'r000000000000003', start: { date: '2027-05-11' } }] }), { uid: ME, zone }), 'booking');
    expect(list).toEqual([]);
  });
});

describe('to-do reminders', () => {
  const todo = (fields) => ({ id: `t${String(Math.random()).slice(2, 17).padEnd(15, '0')}`, name: 'Book museum', due: '2027-05-08', ...fields });
  it('fire at 09:00 on the due date for my and unassigned to-dos', () => {
    const data = { meta: meta({}), todo: [todo({}), todo({ who: ME, name: 'Mine' }), todo({ who: BOB, name: 'Bob' }), todo({ done: true, name: 'Done' }), todo({ list: 'Bob list', name: 'Listed' })],
      listMeta: [{ id: 'l000000000000001', kind: 'todo', name: 'Bob list', assignees: [BOB] }] };
    const list = kinds(tripReminders(trip(data), { uid: ME, zone, now: at('2027-05-01T00:00:00Z'), labels: { todo: (name) => name } }), 'todo');
    expect(list.map((item) => item.title).sort()).toEqual(['Book museum', 'Mine']);
    for (const item of list) expect(item).toMatchObject({ fireAt: at('2027-05-08T08:00:00Z'), until: at('2027-05-08T23:00:00Z'), tab: 'lists' });
  });

  it('summarise overdue to-dos once per trip per day', () => {
    const data = { meta: meta({}), todo: [todo({ due: '2027-05-01' }), todo({ due: '2027-05-02', who: ME }), todo({ due: '2027-05-09' })] };
    const now = at('2027-05-05T12:00:00Z');
    expect(overdueTodos(data, { uid: ME, today: '2027-05-05' })).toHaveLength(2);
    const [overdue] = kinds(tripReminders(trip(data), { uid: ME, zone, now }), 'overdue');
    expect(overdue).toMatchObject({ count: 2, key: `${ref.w}/${ref.s}|overdue|2027-05-05`, fireAt: at('2027-05-05T08:00:00Z'), until: at('2027-05-05T23:00:00Z') });
  });
});

describe('due, upcoming and next', () => {
  const list = allReminders([trip({ meta: meta({ reminderDays: [1] }), res: [{ id: 'r000000000000002', type: 'tour', status: 'confirmed', title: 'Tour', start: { date: '2027-05-11', time: '10:00', tz: zone } }] })], { uid: ME, zone, now: at('2027-05-01T00:00:00Z') });
  it('shows reminders between their time and the moment they stop mattering, once', () => {
    expect(dueNow(list, { now: at('2027-05-09T07:59:00Z') })).toEqual([]);
    const due = dueNow(list, { now: at('2027-05-09T08:00:00Z') });
    expect(due.map((item) => item.kind)).toEqual(['trip']);
    expect(dueNow(list, { now: at('2027-05-09T12:00:00Z'), fired: new Set(due.map((item) => item.key)) })).toEqual([]);
    // Opened late, still before the start: shown on open.
    expect(dueNow(list, { now: at('2027-05-10T21:00:00Z') }).map((item) => item.kind)).toEqual(['trip']);
    expect(dueNow(list, { now: at('2027-05-11T08:30:00Z') }).map((item) => item.kind)).toEqual(['booking']);
    expect(dueNow(list, { now: at('2027-05-11T09:00:01Z') })).toEqual([]);
  });
  it('finds the next firing time and the upcoming list', () => {
    expect(nextFire(list, at('2027-05-01T00:00:00Z'))).toBe(at('2027-05-09T08:00:00Z'));
    expect(nextFire(list, at('2027-05-09T08:00:00Z'))).toBe(at('2027-05-11T08:00:00Z'));
    expect(nextFire(list, at('2027-05-12T00:00:00Z'))).toBeNull();
    expect(upcoming(list, { now: at('2027-05-11T08:30:00Z') }).map((item) => item.kind)).toEqual(['booking']);
  });
  it('skips trips that ended before yesterday', () => {
    expect(allReminders([trip({ meta: meta({ start: '2027-04-01', end: '2027-04-03', reminderDays: [0] }) })], { uid: ME, zone, now: at('2027-04-10T00:00:00Z') })).toEqual([]);
  });
});

describe('replicaData', () => {
  it('applies queued edits over confirmed entities', () => {
    const record = {
      rev: 7,
      confirmed: { 'meta:meta': { id: 'meta', title: 'Lisbon', start: '2027-05-10' }, 'todo:t000000000000001': { id: 't000000000000001', name: 'Old', due: '2027-05-01' }, 'place:p000000000000001': { id: 'p000000000000001', name: 'X' } },
      pending: [
        { op: { t: 'meta', id: 'meta', set: { reminderDays: [2] } } },
        { op: { t: 'todo', id: 't000000000000001', del: true } },
        { op: { t: 'todo', id: 't000000000000002', put: { name: 'New', due: '2027-05-03' } } },
        { op: { do: 'day.remove', args: {} }, effects: [{ t: 'day', id: 'd000000000000001', del: true }] },
      ],
    };
    const data = replicaData(record);
    expect(data.rev).toBe(7);
    expect(data.meta.reminderDays).toEqual([2]);
    expect(data.todo.map((item) => item.name)).toEqual(['New']);
    expect(data.place).toHaveLength(1);
    expect(replicaData(null)).toBeNull();
  });
});

describe('startReminders', () => {
  it('shows a due reminder once, from replicas, and not again after a restart', async () => {
    const { startReminders } = await import('../../src/lib/notify/notifier.js');
    localStorage.clear();
    const record = { rev: 1, confirmed: { 'meta:meta': { id: 'meta', title: 'Lisbon', start: '2027-05-10', end: '2027-05-14', reminderDays: [1] } }, pending: [] };
    const personal = { spaces: { list: async () => [{ ref, role: 'owner', title: 'Lisbon', start: '2027-05-10', end: '2027-05-14' }] } };
    const db = { get: async (key) => (key === `space:${ref.w}:${ref.s}` ? record : undefined) };
    const navigate = [];
    const options = { account: { uuid: ME }, db, personal, app: { navigate: (hash) => navigate.push(hash) }, zone, locks: null, now: () => at('2027-05-09T10:00:00Z') };
    const first = startReminders(options);
    await vi.waitFor(() => expect([...document.querySelectorAll('.toast')].some((node) => node.textContent.includes('Lisbon') && node.textContent.includes('Starts tomorrow'))).toBe(true));
    document.querySelector('.toast-action')?.click();
    expect(navigate).toEqual([`#/t/${ref.w}/${ref.s}/plan`]);
    expect(first.list().map((item) => item.kind)).toEqual(['trip']);
    first.stop();
    for (const node of document.querySelectorAll('.toast-dismiss')) node.click();
    const second = startReminders(options);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([...document.querySelectorAll('.toast')].some((node) => node.textContent.includes('Starts tomorrow'))).toBe(false);
    second.stop();
  });
});
