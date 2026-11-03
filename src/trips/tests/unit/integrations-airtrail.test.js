// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { newId } from '../../src/shared/ids.js';
import { validateEntity } from '../../src/shared/schema/index.js';
import {
  airtrailClient, flightDraft, inTrip, listFlights, ownedHash, planFlightSync, updatePatch, linkPatch, verifyAirtrail,
} from '../../src/lib/integrations/airtrail.js';
import { fakeNet, fixture } from './helpers/fake-net.js';

const config = { url: 'https://air.example.com', key: 'secret-key' };
const v1 = () => fakeNet({
  'GET /api/v1/me': () => ({ json: { data: { id: 'u-alice', username: 'alice', displayName: 'Alice' } } }),
  'GET /api/v1/flights': (url) => ({ json: fixture(url.searchParams.get('cursor') === 'c2' ? 'airtrail-flights-2.json' : 'airtrail-flights-1.json') }),
});

describe('AirTrail adapter', () => {
  it('verifies the key and follows cursors', async () => {
    const net = v1();
    const client = airtrailClient(net.puter, config);
    expect(await verifyAirtrail(client)).toEqual({ user: { id: 'u-alice', name: 'Alice' } });
    const { flights, truncated } = await listFlights(client);
    expect(flights.map((flight) => flight.id)).toEqual([101, 102, 77, 78]);
    expect(truncated).toBe(false);
    expect(net.calls.map((call) => call.url.search)).toEqual(['', '?limit=100', '?limit=100&cursor=c2']);
    expect(net.calls.every((call) => call.headers.authorization === 'Bearer secret-key' && call.url.origin === 'https://air.example.com')).toBe(true);
  });

  it('falls back to the older flight list', async () => {
    const net = fakeNet({ 'GET /api/flight/list': () => ({ json: fixture('airtrail-legacy.json') }) });
    const client = airtrailClient(net.puter, config);
    expect(await verifyAirtrail(client)).toEqual({ user: null, legacy: true });
    const { flights } = await listFlights(client);
    expect(flights).toHaveLength(1);
    const draft = flightDraft(flights[0], { me: '1' });
    expect(draft.fields.legs[0]).toMatchObject({ dep: { date: '2026-05-02', time: '10:15' }, arr: { date: '2026-05-02', time: '12:55' }, seat: '12A' });
  });

  it('maps a flight to a booking in airport local time with the user seat', () => {
    const [flight] = fixture('airtrail-flights-1.json').data;
    const draft = flightDraft(flight, { me: 'u-alice', classLabel: (value) => `cabin:${value}` });
    expect(draft.ext).toBe('101');
    expect(draft.fields).toMatchObject({
      type: 'flight', title: 'FRA → JFK', status: 'confirmed', notes: 'Window seat booked',
      start: { date: '2026-05-02', time: '10:15', tz: 'Europe/Berlin' }, end: { date: '2026-05-02', time: '12:55', tz: 'America/New_York' },
      src: { kind: 'airtrail', ext: '101', hash: draft.hash },
    });
    expect(draft.fields.legs).toEqual([{
      from: { name: 'Frankfurt am Main Airport', code: 'FRA', lat: 50.0333, lng: 8.5706, tz: 'Europe/Berlin' },
      to: { name: 'John F. Kennedy International Airport', code: 'JFK', lat: 40.6398, lng: -73.7789, tz: 'America/New_York' },
      dep: { date: '2026-05-02', time: '10:15' }, arr: { date: '2026-05-02', time: '12:55' },
      carrier: 'Lufthansa', number: 'LH400', seat: '31A', cls: 'cabin:business',
    }]);
    expect(() => validateEntity('trip', 'res', draft.fields)).not.toThrow();
    expect(draft.hash).toBe(ownedHash(draft.fields));
  });

  it('handles overnight flights, missing times and unusable records', () => {
    const [, overnight] = fixture('airtrail-flights-1.json').data;
    const night = flightDraft(overnight);
    expect(night.fields.legs[0]).toMatchObject({ dep: { date: '2026-05-09', time: '18:30' }, arr: { date: '2026-05-10', time: '08:10' } });
    expect(night.fields.notes).toBeUndefined();
    const [dateOnly, noDate] = fixture('airtrail-flights-2.json').data;
    const plain = flightDraft(dateOnly, { classLabel: (value) => value });
    expect(plain.fields.legs[0]).toMatchObject({ dep: { date: '2025-11-20' }, arr: { date: '2025-11-20' }, seat: '4D', cls: 'economy+' });
    expect(plain.fields.legs[0].dep.time).toBeUndefined();
    expect(flightDraft(noDate)).toBeNull();
    expect(flightDraft(null)).toBeNull();
    expect(flightDraft({ id: 1, date: 'yesterday' })).toBeNull();
  });

  it('plans a sync against the trip: new, changed, unchanged, outside and dismissed', () => {
    const drafts = [...fixture('airtrail-flights-1.json').data, ...fixture('airtrail-flights-2.json').data].map((flight) => flightDraft(flight, { me: 'u-alice' }));
    const trip = { start: '2026-05-01', end: '2026-05-09' };
    expect(inTrip(drafts[0].fields, trip)).toBe(true);
    expect(inTrip(drafts[1].fields, trip)).toBe(true);
    expect(inTrip(drafts[2].fields, trip)).toBe(false);
    expect(inTrip(drafts[0].fields, {})).toBe(false);

    const empty = planFlightSync(drafts, [], trip);
    expect(empty.add.map((entry) => entry.draft.ext)).toEqual(['101', '102']);
    expect(empty.outside).toBe(1);

    const imported = { id: newId(), ...drafts[0].fields };
    const changed = { id: newId(), ...drafts[1].fields, src: { ...drafts[1].fields.src, hash: 'old' } };
    const manual = { id: newId(), type: 'flight', title: 'Home', status: 'confirmed', legs: [{ from: { code: 'LIS' }, to: { code: 'OPO' }, dep: { date: '2025-11-20' }, arr: { date: '2025-11-20' } }] };
    const plan = planFlightSync(drafts, [imported, changed, manual], trip);
    expect(plan.unchanged).toBe(1);
    expect(plan.update.map((entry) => entry.res.id)).toEqual([changed.id]);
    expect(plan.add).toEqual([]);

    const all = planFlightSync(drafts, [manual], { ...trip, all: true, dismissed: new Set(['102']) });
    expect(all.add.map((entry) => [entry.draft.ext, entry.duplicate?.id ?? null, entry.dismissed])).toEqual([
      ['77', manual.id, false], ['101', null, false], ['102', null, true],
    ]);
    const hidden = planFlightSync(drafts, [], { ...trip, dismissed: new Set(['102']) });
    expect(hidden.add.map((entry) => entry.draft.ext)).toEqual(['101']);
    expect(hidden.dismissed).toBe(1);
  });

  it('updates untouched bookings fully and edited ones only in their flight details', () => {
    const [flight] = fixture('airtrail-flights-1.json').data;
    const before = flightDraft(flight, { me: 'u-alice' });
    const after = flightDraft({ ...flight, departure: '2026-05-02T11:00:00.000+02:00', note: 'Rebooked' }, { me: 'u-alice' });
    const untouched = { id: newId(), v: 3, ...before.fields, people: ['x1'] };
    const patch = updatePatch(untouched, after);
    expect(patch.set['legs']).toBeDefined();
    expect(patch.set.legs[0].dep).toEqual({ date: '2026-05-02', time: '11:00' });
    expect(patch.set.notes).toBe('Rebooked');
    expect(patch.set.src).toEqual(after.fields.src);
    expect(patch.unset).toEqual([]);

    const edited = { ...untouched, title: 'Our flight to New York', notes: 'Ours', legs: [{ ...before.fields.legs[0], code: 'ABC123' }] };
    const kept = updatePatch(edited, after);
    expect(kept.set.title).toBeUndefined();
    expect(kept.set.notes).toBeUndefined();
    expect(kept.set.legs[0]).toMatchObject({ code: 'ABC123', dep: { time: '11:00' } });
    expect(kept.set.src.hash).toBe(after.hash);
  });

  it('links a booking added by hand and fills what it lacks', () => {
    const [flight] = fixture('airtrail-flights-1.json').data;
    const draft = flightDraft(flight, { me: 'u-alice' });
    const manual = { id: newId(), type: 'flight', title: 'NYC', status: 'pending', legs: [{ from: { code: 'FRA' }, to: { code: 'JFK' }, dep: { date: '2026-05-02' }, arr: { date: '2026-05-02' } }] };
    const patch = linkPatch(manual, draft);
    expect(patch.set.src).toMatchObject({ kind: 'airtrail', ext: '101' });
    expect(patch.set.legs[0]).toMatchObject({ carrier: 'Lufthansa', number: 'LH400', dep: { time: '10:15' } });
    expect(patch.set.title).toBeUndefined();
    expect(patch.set.review).toBeUndefined();
    // The next pull of the same flight finds nothing to update; the booking counts as edited here.
    const linked = { ...manual, ...patch.set };
    expect(planFlightSync([draft], [linked], { start: '2026-05-01', end: '2026-05-10' })).toMatchObject({ add: [], update: [], unchanged: 1 });
    const moved = flightDraft({ ...flight, departure: '2026-05-02T11:00:00.000+02:00' }, { me: 'u-alice' });
    expect(planFlightSync([moved], [linked], {}).update).toMatchObject([{ edited: true }]);
  });
});
