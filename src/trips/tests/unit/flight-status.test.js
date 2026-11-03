// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { mapFlight } from '../../src/services/flights.js';
import {
  bestTime, delayMinutes, describeFlight, flightDesignator, localAt, mergeSeen, pickFlight, statusQuery, statusWindow, visibleChanges,
} from '../../src/views/trip/bookings/status/model.js';
import { createStatusStore } from '../../src/views/trip/bookings/status/store.js';
import strings from '../../src/lib/i18n/en/flightStatus.js';
import { placeholders } from '../../src/lib/i18n/plural.js';

const utc = (d, h, m = 0) => Date.UTC(2026, 10, d, h, m);
const side = (iata, tz, times, extra = {}) => ({ airport: { iata, timeZone: tz }, ...times, ...extra });
const at = (value) => ({ utc: value });
const flight = (overrides = {}) => mapFlight({
  number: 'KL 1001', status: 'Expected', codeshareStatus: 'IsOperator',
  departure: side('AMS', 'Europe/Amsterdam', { scheduledTime: { utc: '2026-11-02 09:15Z', local: '2026-11-02 10:15+01:00' } }, { terminal: '2', gate: 'D7', quality: ['Live'] }),
  arrival: side('LHR', 'Europe/London', { scheduledTime: { utc: '2026-11-02 10:35Z', local: '2026-11-02 10:35+00:00' } }, { terminal: '4' }),
  ...overrides,
});
const leg = (overrides = {}) => ({
  from: { code: 'AMS', tz: 'Europe/Amsterdam' }, to: { code: 'LHR', tz: 'Europe/London' },
  dep: { date: '2026-11-02', time: '10:15' }, arr: { date: '2026-11-02', time: '10:35' }, carrier: 'KLM', number: 'KL 1001', ...overrides,
});

describe('flight designators', () => {
  it.each([
    [{ number: 'KL 1001' }, 'KL1001'], [{ number: 'kl1001' }, 'KL1001'], [{ number: 'KLM 1001' }, 'KLM1001'], [{ number: 'U2 0123' }, 'U2123'],
    [{ number: '1001', carrier: 'KL' }, 'KL1001'], [{ number: '1001', carrier: 'KLM' }, 'KLM1001'], [{ number: '83', carrier: 'TAP Air Portugal (TP)' }, 'TP83'],
    [{ number: 'BA-0001' }, 'BA1'], [{ number: '9W 7' }, '9W7'],
  ])('%j → %s', (input, expected) => expect(flightDesignator(input)).toBe(expected));
  it.each([[{ number: '1001', carrier: 'Air France' }], [{ number: '' }], [{ number: '12 345' }], [{ number: '99 123' }], [{}]])('%j has none', (input) => expect(flightDesignator(input)).toBeNull());
  it('needs a departure date for a query', () => {
    expect(statusQuery(leg())).toEqual({ number: 'KL1001', date: '2026-11-02' });
    expect(statusQuery(leg({ dep: { date: '' } }))).toBeNull();
  });
});

describe('status window', () => {
  it('is live from three days before departure until six hours after arrival, in the airports’ zones', () => {
    const l = leg();
    expect(statusWindow(l, utc(2, 9, 15) - 3 * 86_400_000 - 60_000)).toBe('early');
    expect(statusWindow(l, utc(2, 9, 15) - 3 * 86_400_000 + 60_000)).toBe('live');
    expect(statusWindow(l, utc(2, 10, 35) + 6 * 3_600_000 - 60_000)).toBe('live');
    expect(statusWindow(l, utc(2, 10, 35) + 6 * 3_600_000 + 60_000)).toBe('past');
    expect(statusWindow({ dep: {} }, utc(2, 9))).toBe('none');
  });
  it('treats an untimed leg as its whole local day', () => {
    const l = leg({ dep: { date: '2026-11-02' }, arr: {} });
    expect(statusWindow(l, Date.UTC(2026, 10, 3, 4))).toBe('live');
    expect(statusWindow(l, Date.UTC(2026, 10, 3, 5))).toBe('past');
  });
});

describe('matching a leg', () => {
  const ams = flight();
  const other = flight({ departure: side('LHR', 'Europe/London', {}), arrival: side('JFK', 'America/New_York', {}) });
  const codeshare = { ...ams, codeshare: true };
  it('prefers both airports, then the departure, then a single answer', () => {
    expect(pickFlight([other, ams], leg())).toBe(ams);
    expect(pickFlight([codeshare, ams], leg())).toBe(ams);
    expect(pickFlight([ams], leg({ to: { code: 'LGW' } }))).toBe(ams);
    expect(pickFlight([other, ams], leg({ from: {}, to: {} }))).toBeNull();
    expect(pickFlight([ams], leg({ from: {}, to: {} }))).toBe(ams);
    expect(pickFlight([other], leg())).toBeNull();
  });
});

describe('describing status', () => {
  it('reads on time only with live data, scheduled otherwise', () => {
    expect(describeFlight(flight(), leg())).toMatchObject({ tone: 'success', label: { key: 'flightStatus.onTime' } });
    const quiet = flight(); quiet.dep.live = false;
    expect(describeFlight(quiet, leg())).toMatchObject({ tone: '', label: { key: 'flightStatus.scheduled' } });
  });
  it('counts delays from the revised time and keeps short ones on time', () => {
    const late = flight(); late.dep.revised = utc(2, 9, 40);
    expect(delayMinutes(late.dep)).toBe(25);
    expect(describeFlight(late, leg())).toMatchObject({ tone: 'warn', label: { key: 'flightStatus.delayed', values: { duration: 25 } }, depDelay: 25 });
    const slight = flight(); slight.dep.predicted = utc(2, 9, 29);
    expect(describeFlight(slight, leg()).label.key).toBe('flightStatus.onTime');
    const announced = flight({ status: 'Delayed' });
    expect(describeFlight(announced, leg()).label.key).toBe('flightStatus.delayedUnknown');
  });
  it('prefers actual over revised over predicted times', () => {
    const value = { scheduled: 1, predicted: 2, revised: 3, runway: 4 };
    expect(bestTime(value)).toEqual({ at: 4, kind: 'actual' });
    expect(bestTime({ ...value, runway: null })).toEqual({ at: 3, kind: 'revised' });
    expect(bestTime({ scheduled: 1 })).toEqual({ at: 1, kind: 'scheduled' });
    expect(delayMinutes({ scheduled: 1 })).toBeNull();
  });
  it('shows local airport times and the day a delay pushes into', () => {
    const night = mapFlight({
      number: 'DL 1', status: 'Expected',
      departure: side('JFK', 'America/New_York', { scheduledTime: at('2026-11-03 04:30Z'), revisedTime: at('2026-11-03 05:45Z') }),
      arrival: side('LAX', 'America/Los_Angeles', { scheduledTime: at('2026-11-03 10:40Z') }),
    });
    const view = describeFlight(night, { from: { code: 'JFK', tz: 'America/New_York' }, to: { code: 'LAX' }, dep: { date: '2026-11-02', time: '23:30' } });
    expect(view.dep.scheduled).toEqual({ date: '2026-11-02', time: '23:30', tz: 'America/New_York' });
    expect(view.dep.current).toEqual({ date: '2026-11-03', time: '00:45', tz: 'America/New_York' });
    expect(view.dep.shift).toBe(1);
    expect(view.arr.scheduled).toEqual({ date: '2026-11-03', time: '02:40', tz: 'America/Los_Angeles' });
    expect(view.label).toEqual({ key: 'flightStatus.delayed', values: { duration: 75 } });
  });
  it('handles east-to-west arrivals earlier on the clock than departure', () => {
    const pacific = mapFlight({
      number: 'NH 8', status: 'EnRoute',
      departure: side('NRT', 'Asia/Tokyo', { scheduledTime: at('2026-11-02 08:00Z'), runwayTime: at('2026-11-02 08:20Z') }),
      arrival: side('SFO', 'America/Los_Angeles', { scheduledTime: at('2026-11-02 18:00Z'), predictedTime: at('2026-11-02 18:10Z') }),
    });
    const view = describeFlight(pacific, { from: { code: 'NRT' }, to: { code: 'SFO' }, dep: { date: '2026-11-02', time: '17:00' } });
    expect(view.dep.scheduled.time).toBe('17:00');
    expect(view.arr.scheduled).toEqual({ date: '2026-11-02', time: '10:00', tz: 'America/Los_Angeles' });
    expect(view.arr.current.time).toBe('10:10');
    expect(view).toMatchObject({ phase: 'airborne', tone: 'success', label: { key: 'flightStatus.airborne' }, arrDelay: 10 });
  });
  it('uses the provider offset when no zone is known', () => {
    expect(localAt(utc(2, 9, 15), { offset: 330 }, null)).toEqual({ date: '2026-11-02', time: '14:45', tz: null, offset: 330 });
    expect(localAt(utc(2, 9, 15), {}, 'Asia/Kolkata')).toEqual({ date: '2026-11-02', time: '14:45', tz: 'Asia/Kolkata' });
  });
  it('flags a schedule change against the booked time', () => {
    const view = describeFlight(flight(), leg({ dep: { date: '2026-11-02', time: '09:50' } }));
    expect(view.dep.retimed).toEqual({ minutes: 25, booked: { date: '2026-11-02', time: '09:50' } });
    expect(describeFlight(flight(), leg()).dep.retimed).toBeNull();
  });
  it.each([
    ['Canceled', 'danger', 'flightStatus.cancelled'], ['CanceledUncertain', 'warn', 'flightStatus.uncertain'], ['Diverted', 'danger', 'flightStatus.diverted'],
    ['GateClosed', 'warn', 'flightStatus.gateClosed'], ['CheckIn', 'accent', 'flightStatus.checkIn'],
  ])('%s reads as %s', (status, tone, key) => expect(describeFlight(flight({ status }), leg())).toMatchObject({ tone, label: { key } }));
  it('names the gate while boarding and lateness after landing', () => {
    expect(describeFlight(flight({ status: 'Boarding' }), leg()).label).toEqual({ key: 'flightStatus.boardingGate', values: { gate: 'D7' } });
    const landed = flight({ status: 'Arrived' }); landed.arr.runway = utc(2, 11, 5);
    expect(describeFlight(landed, leg())).toMatchObject({ phase: 'landed', tone: 'warn', label: { key: 'flightStatus.landedLate', values: { duration: 30 } } });
  });
  it('passes each label the placeholders its string uses', () => {
    const early = flight(); early.dep.revised = utc(2, 8, 55);
    const late = flight(); late.dep.revised = utc(2, 9, 40);
    const landed = flight({ status: 'Arrived' }); landed.arr.runway = utc(2, 11, 5);
    const views = [early, late, landed, flight({ status: 'Boarding' })].map((item) => describeFlight(item, leg()));
    expect(views[0].label).toEqual({ key: 'flightStatus.early', values: { duration: 20 } });
    for (const { label } of views) expect(Object.keys(label.values ?? {}).sort(), label.key).toEqual(placeholders(strings[label.key]).sort());
  });
});

describe('gate changes', () => {
  it('remembers the first gate and reports changes until they revert', () => {
    const first = mergeSeen(null, flight(), 1);
    expect(first).toEqual({ fields: { depTerminal: '2', depGate: 'D7', arrTerminal: '4' }, changes: {}, at: 1 });
    const moved = flight(); moved.dep.gate = 'E18';
    const second = mergeSeen(first, moved, 2);
    expect(second.changes).toEqual({ depGate: { from: 'D7', to: 'E18', at: 2 } });
    const again = flight(); again.dep.gate = 'F3';
    expect(mergeSeen(second, again, 3).changes.depGate).toEqual({ from: 'D7', to: 'F3', at: 3 });
    expect(mergeSeen(second, flight(), 4).changes).toEqual({});
    const dropped = flight(); dropped.dep.gate = null;
    expect(mergeSeen(second, dropped, 5)).toMatchObject({ fields: { depGate: 'E18' }, changes: { depGate: { to: 'E18' } } });
  });
  it('hides departure changes once the flight has left', () => {
    const seen = { changes: { depGate: { from: 'D7', to: 'E18' }, belt: { from: '7', to: '9' } } };
    expect(Object.keys(visibleChanges(seen, { phase: 'scheduled' }))).toEqual(['depGate', 'belt']);
    expect(Object.keys(visibleChanges(seen, { phase: 'airborne' }))).toEqual(['belt']);
  });
});

describe('status store', () => {
  const query = { number: 'KL1001', date: '2026-11-02' };
  const memory = () => { const items = new Map(); return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, value) }; };
  const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });
  function make({ key = 'secret-key-123', available = true, status } = {}) {
    let now = utc(2, 6);
    const flights = { available: vi.fn(async () => available), status: vi.fn(status ?? (async () => ({ data: { flights: [flight()], fetchedAt: now }, attribution: [], cached: false, stale: false }))) };
    const keys = { get: vi.fn(async () => key), subscribe: () => () => {} };
    const store = createStatusStore({ flights, keys, account: 'alice', now: () => now, storage: memory(), doc: null, win: null, online: () => true });
    return { store, flights, keys, advance: (ms) => { now += ms; } };
  }
  it('loads automatic entries once and refreshes after they expire', async () => {
    const { store, flights, advance } = make();
    store.ensure(query, { auto: true });
    store.ensure(query, { auto: true });
    await settle();
    expect(flights.status).toHaveBeenCalledOnce();
    expect(flights.status.mock.calls[0][1].key).toBe('secret-key-123');
    expect(store.get(query)).toMatchObject({ state: 'ready', code: null });
    store.ensure(query, { auto: true });
    await settle();
    expect(flights.status).toHaveBeenCalledOnce();
    advance(31 * 60_000);
    store.ensure(query, { auto: true });
    await settle();
    expect(flights.status).toHaveBeenCalledTimes(2);
    store.destroy();
  });
  it('does not call without a key or provider, and waits for a manual check outside the window', async () => {
    const none = make({ key: null });
    none.store.ensure(query, { auto: true }); await settle();
    expect(none.store.get(query).state).toBe('nokey');
    expect(none.flights.status).not.toHaveBeenCalled();
    const off = make({ available: false });
    off.store.ensure(query, { auto: true }); await settle();
    expect(off.store.get(query).state).toBe('unconfigured');
    const early = make();
    early.store.ensure(query); await settle();
    expect(early.flights.status).not.toHaveBeenCalled();
    early.store.ensure(query, { force: true }); await settle();
    expect(early.flights.status).toHaveBeenCalledOnce();
  });
  it('keeps the last answer when a refresh fails and records the reason', async () => {
    let fail = false;
    const { store, advance } = make({ status: async () => { if (fail) throw Object.assign(new Error('x'), { code: 'quota' }); return { data: { flights: [flight()], fetchedAt: utc(2, 6) }, attribution: [] }; } });
    store.ensure(query, { auto: true }); await settle();
    fail = true; advance(31 * 60_000);
    store.ensure(query, { auto: true }); await settle();
    expect(store.get(query)).toMatchObject({ state: 'ready', code: 'quota' });
    expect(store.get(query).result.data.flights).toHaveLength(1);
    const broken = make({ status: async () => { throw Object.assign(new Error('x'), { code: 'key_rejected' }); } });
    broken.store.ensure(query, { auto: true }); await settle();
    expect(broken.store.get(query)).toMatchObject({ state: 'error', code: 'key_rejected' });
  });
  it('tracks gate changes across answers', async () => {
    let gate = 'D7';
    const { store, advance } = make({ status: async () => { const f = flight(); f.dep.gate = gate; return { data: { flights: [f], fetchedAt: utc(2, 6) }, attribution: [] }; } });
    store.ensure(query, { auto: true }); await settle();
    gate = 'E18'; advance(31 * 60_000);
    store.ensure(query, { auto: true }); await settle();
    expect(store.seen(query, flight()).changes.depGate).toMatchObject({ from: 'D7', to: 'E18' });
  });
});
