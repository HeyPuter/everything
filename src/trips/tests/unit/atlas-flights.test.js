// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { EARTH_CIRCUMFERENCE_M, EARTH_RADIUS_M, flightLegs, flightStats, greatCircleMeters } from '../../src/lib/atlas/flights.js';

const UID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TODAY = '2026-10-24';
const AIRPORTS = {
  JFK: { lat: 40.6413, lng: -73.7781, name: 'JFK' }, LHR: { lat: 51.47, lng: -0.4543, name: 'Heathrow' },
  SYD: { lat: -33.9399, lng: 151.1753, name: 'Sydney' }, LAX: { lat: 33.9416, lng: -118.4085, name: 'LAX' },
  NRT: { lat: 35.772, lng: 140.3929, name: 'Narita' }, ANC: { lat: 61.1743, lng: -149.9962, name: 'Anchorage' },
};
const airport = (code) => AIRPORTS[code] ?? null;
const km = (meters) => Math.round(meters / 1000);
const leg = (from, to, date, extra = {}) => ({ from: { code: from }, to: { code: to }, dep: { date }, arr: { date }, ...extra });
const flight = (id, legs, extra = {}) => ({ id, type: 'flight', title: id, status: 'confirmed', legs, ...extra });
const trip = (key, start, end, res, cached = true) => ({ key, start, end, cached, places: [], res });

describe('great-circle distance', () => {
  it('matches known airport pairs on the mean-radius sphere', () => {
    // Independent check: the angle between the two unit vectors.
    const vector = ({ lat, lng }) => { const r = Math.PI / 180; return [Math.cos(lat * r) * Math.cos(lng * r), Math.cos(lat * r) * Math.sin(lng * r), Math.sin(lat * r)]; };
    const angle = (a, b) => { const [u, v] = [vector(a), vector(b)]; return Math.acos(u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) * EARTH_RADIUS_M; };
    for (const [a, b] of [['JFK', 'LHR'], ['LAX', 'SYD'], ['NRT', 'ANC']]) expect(greatCircleMeters(AIRPORTS[a], AIRPORTS[b])).toBeCloseTo(angle(AIRPORTS[a], AIRPORTS[b]), 3);
    expect(km(greatCircleMeters(AIRPORTS.JFK, AIRPORTS.LHR))).toBe(5540);
    expect(km(greatCircleMeters(AIRPORTS.LAX, AIRPORTS.SYD))).toBe(12061);
    // Within 0.5% of published ellipsoidal distances.
    expect(Math.abs(greatCircleMeters(AIRPORTS.JFK, AIRPORTS.LHR) / 5_555_000 - 1)).toBeLessThan(0.005);
    expect(Math.abs(greatCircleMeters(AIRPORTS.LAX, AIRPORTS.SYD) / 12_051_000 - 1)).toBeLessThan(0.005);
  });

  it('handles zero, poles, the antimeridian and antipodes', () => {
    expect(greatCircleMeters({ lat: 10, lng: 20 }, { lat: 10, lng: 20 })).toBe(0);
    expect(greatCircleMeters({ lat: 0, lng: 179.5 }, { lat: 0, lng: -179.5 })).toBeCloseTo(EARTH_RADIUS_M * Math.PI / 180, 3);
    expect(greatCircleMeters({ lat: 90, lng: 0 }, { lat: -90, lng: 123 })).toBeCloseTo(Math.PI * EARTH_RADIUS_M, 3);
    expect(greatCircleMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 180 })).toBeCloseTo(Math.PI * EARTH_RADIUS_M, 3);
    expect(greatCircleMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 90 })).toBeCloseTo(EARTH_RADIUS_M * Math.PI / 2, 3);
  });

  it('is symmetric and rejects invalid points', () => {
    expect(greatCircleMeters(AIRPORTS.SYD, AIRPORTS.LAX)).toBe(greatCircleMeters(AIRPORTS.LAX, AIRPORTS.SYD));
    expect(greatCircleMeters({ lat: 91, lng: 0 }, AIRPORTS.JFK)).toBeNaN();
    expect(greatCircleMeters({ lat: 0 }, AIRPORTS.JFK)).toBeNaN();
    expect(greatCircleMeters(null, AIRPORTS.JFK)).toBeNaN();
  });
});

describe('flown legs', () => {
  it('counts legs of started trips up to today, from coordinates or airport codes', () => {
    const trips = [
      trip('past', '2025-05-01', '2025-05-10', [flight('f1', [leg('JFK', 'LHR', '2025-05-01'), leg('LHR', 'JFK', '2025-05-10')])]),
      trip('now', '2026-10-20', '2026-10-30', [flight('f2', [
        { from: { code: 'LAX', lat: 33.9416, lng: -118.4085 }, to: { name: 'Sydney', lat: -33.9399, lng: 151.1753 }, dep: { date: '2026-10-20' }, arr: { date: '2026-10-22' } },
        leg('SYD', 'LAX', '2026-10-29'),
      ])]),
      trip('next', '2027-01-01', '2027-01-05', [flight('f3', [leg('JFK', 'LHR', '2027-01-01')])]),
      trip('someday', null, null, [flight('f4', [leg('JFK', 'LHR', '2025-01-01')])]),
      trip('elsewhere', '2024-01-01', '2024-01-02', [flight('f5', [leg('JFK', 'LHR', '2024-01-01')])], false),
    ];
    const { legs, unresolved } = flightLegs(trips, { today: TODAY, uid: UID, airport });
    expect(legs.map((item) => `${item.from.code ?? item.from.name}-${item.to.code ?? item.to.name}`)).toEqual(['JFK-LHR', 'LHR-JFK', 'LAX-Sydney']);
    expect(unresolved).toBe(0);
    const stats = flightStats({ legs, unresolved });
    expect(stats).toMatchObject({ flights: 3, airports: 4 });
    expect(stats.meters).toBeCloseTo(2 * greatCircleMeters(AIRPORTS.JFK, AIRPORTS.LHR) + greatCircleMeters(AIRPORTS.LAX, AIRPORTS.SYD), 3);
    expect(stats.longest.to.name).toBe('Sydney');
    expect(stats.shortest.from.code).toBe('JFK');
    expect(stats.aroundEarth).toBeCloseTo(stats.meters / EARTH_CIRCUMFERENCE_M, 10);
    expect(stats.byYear.map((year) => [year.year, year.flights])).toEqual([[2026, 1], [2025, 2]]);
  });

  it('skips cancelled bookings, other travellers, other transport and unknown airports', () => {
    const trips = [trip('past', '2025-05-01', '2025-05-10', [
      flight('cancelled', [leg('JFK', 'LHR', '2025-05-01')], { status: 'cancelled' }),
      flight('theirs', [leg('LAX', 'SYD', '2025-05-02')], { people: [OTHER] }),
      flight('ours', [leg('NRT', 'ANC', '2025-05-03')], { people: [OTHER, UID] }),
      { id: 'train', type: 'train', status: 'confirmed', legs: [leg('JFK', 'LHR', '2025-05-04')] },
      flight('mystery', [leg('ZZZ', 'LHR', '2025-05-05'), { from: { name: 'Nowhere' }, to: { code: 'LHR' }, dep: { date: '2025-05-06' }, arr: { date: '2025-05-06' } }]),
    ])];
    const { legs, unresolved } = flightLegs(trips, { today: TODAY, uid: UID, airport });
    expect(legs.map((item) => item.resId)).toEqual(['ours']);
    expect(unresolved).toBe(2);
    expect(flightLegs(trips, { today: TODAY, uid: null, airport }).legs.map((item) => item.resId)).toEqual(['theirs', 'ours']);
  });

  it('counts the same flight in two trips once', () => {
    const shared = flight('a', [leg('JFK', 'LHR', '2025-05-01', { carrier: 'BA', number: '178' })]);
    const copy = flight('b', [leg('jfk', 'LHR', '2025-05-01', { carrier: 'ba', number: ' 178' })]);
    const other = flight('c', [leg('JFK', 'LHR', '2025-05-01', { carrier: 'VS', number: '4' })]);
    const { legs } = flightLegs([trip('one', '2025-05-01', null, [shared]), trip('two', '2025-04-28', '2025-05-03', [copy, other])], { today: TODAY, airport });
    expect(legs.map((item) => item.resId)).toEqual(['a', 'c']);
  });

  it('reports empty stats and requires a date', () => {
    expect(flightStats()).toMatchObject({ flights: 0, meters: 0, longest: null, airports: 0, aroundEarth: 0, byYear: [] });
    expect(() => flightLegs([], { today: 'today' })).toThrow(RangeError);
  });
});
