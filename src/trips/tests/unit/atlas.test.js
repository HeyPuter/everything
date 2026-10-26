// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { aggregateAtlas, localToday, reservationStops, tripPhase } from '../../src/lib/atlas/aggregate.js';
import { COUNTRY_CODES, continentOf, countryCode, featureCode, searchText } from '../../src/lib/atlas/countries.js';
import { normalizeMarks, replicaEntities, tripInput, writeMarks } from '../../src/lib/atlas/data.js';
import { splitAntimeridian, splitPolygon } from '../../src/lib/atlas/geometry.js';
import { createLocator } from '../../src/lib/atlas/locate.js';
import { topologyFeatures } from '../../src/map/topology.js';

const UID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TODAY = '2026-10-24';
const place = (id, cc, extra = {}) => ({ id, name: id, cc, ...extra });
const trip = (key, start, end, { places = [], res = [], cached = true } = {}) => ({ key, ref: { w: 'trips-aaaaaaaaaa', s: key, k: 'trip' }, title: key, start, end, cached, places, res });
const leg = (from, to, dep, arr) => ({ from: { code: from }, to: { code: to }, dep, arr });
const at = (date, time) => ({ date, time });
const airports = { JFK: 'US', LHR: 'GB', CDG: 'FR', NRT: 'JP' };
const run = (trips, options = {}) => aggregateAtlas({ trips, today: TODAY, uid: UID, airportCountry: (code) => airports[code] ?? null, ...options });

describe('atlas aggregation', () => {
  it('counts started trips, shows future trips as planned and skips undated ones', () => {
    const result = run([
      trip('past', '2025-05-01', '2025-05-10', { places: [place('louvre', 'FR')] }),
      trip('now', '2026-10-20', '2026-11-02', { places: [place('prado', 'ES')] }),
      trip('next', '2027-03-01', '2027-03-05', { places: [place('fuji', 'JP'), place('eiffel', 'FR')] }),
      trip('someday', null, null, { places: [place('sydney', 'AU')] }),
    ]);
    expect(result.visited).toEqual(['ES', 'FR']);
    expect(result.planned).toEqual(['JP']);
    expect(result.countries.has('AU')).toBe(false);
    expect(result.countries.get('FR').items.map((item) => [item.name, item.planned])).toEqual([['louvre', false], ['eiffel', true]]);
    expect(result.stats).toMatchObject({ countries: 2, planned: 1, trips: 2, plannedTrips: 1, undatedTrips: 1, continents: 1, continentList: ['EU'] });
  });

  it('counts only the caller’s own visited marks, in any trip', () => {
    const result = run([
      trip('someday', null, null, { places: [place('opera', 'AU', { visited: { [UID]: true } }), place('harbour', 'NZ', { visited: { [OTHER]: true } })] }),
      trip('next', '2027-01-01', null, { places: [place('temple', 'TH', { visited: { [UID]: true } })] }),
    ]);
    expect(result.visited.sort()).toEqual(['AU', 'TH']);
    expect(result.countries.has('NZ')).toBe(false);
    expect(result.countries.get('AU').items[0]).toMatchObject({ mine: true, planned: false });
    expect(result.stats.places).toBe(2);
  });

  it('applies manual marks and hidden countries', () => {
    const trips = [trip('past', '2024-01-01', '2024-01-03', { places: [place('a', 'DE'), place('b', 'AT')] }), trip('next', '2027-01-01', null, { places: [place('c', 'IT')] })];
    const result = run(trips, { marks: { visited: { PE: 'manual', AT: 'manual', zz: 'manual' }, hidden: { DE: true, AT: true, IT: true } } });
    expect(result.visited.sort()).toEqual(['AT', 'PE']);
    expect(result.hidden).toEqual(['DE', 'IT']);
    expect(result.planned).toEqual([]);
    expect(result.countries.get('AT')).toMatchObject({ manual: true, auto: true, hidden: true, status: 'visited' });
    expect(result.countries.get('PE')).toMatchObject({ manual: true, auto: false, last: null });
    expect(result.stats.continents).toBe(2);
  });

  it('folds territories the map draws inside another country and resolves coordinates', () => {
    const locate = vi.fn((lat) => (lat > 0 ? 'CA' : null));
    const result = run([trip('past', '2026-01-01', '2026-01-05', { places: [place('reunion', 'RE'), place('north', undefined, { lat: 50, lng: -100 }), place('sea', undefined, { lat: -40, lng: -30 })] })], { locate });
    expect(result.visited.sort()).toEqual(['CA', 'FR']);
    expect(locate).toHaveBeenCalledTimes(2);
  });

  it('drops layover airports but keeps long stopovers and skips cancelled bookings', () => {
    const quick = { id: 'r1', type: 'flight', legs: [leg('JFK', 'LHR', at('2026-02-01', '18:00'), at('2026-02-02', '06:00')), leg('LHR', 'CDG', at('2026-02-02', '08:30'), at('2026-02-02', '10:45'))] };
    expect(reservationStops(quick).map((stop) => stop.code)).toEqual(['JFK', 'CDG']);
    const stopover = structuredClone(quick); stopover.legs[1].dep = at('2026-02-05', '08:30');
    expect(reservationStops(stopover).map((stop) => stop.code)).toEqual(['JFK', 'LHR', 'LHR', 'CDG']);
    const undated = structuredClone(quick); delete undated.legs[1].dep;
    expect(reservationStops(undated).map((stop) => stop.code)).toEqual(['JFK', 'CDG']);
    expect(reservationStops({ ...quick, status: 'cancelled' })).toEqual([]);
    const hotel = { id: 'r2', type: 'lodging', title: 'Hotel', location: { name: 'Hotel', lat: 35.6, lng: 139.7 }, start: { date: '2026-02-03' } };
    expect(reservationStops(hotel)).toEqual([{ name: 'Hotel', lat: 35.6, lng: 139.7, date: '2026-02-03' }]);

    const result = run([trip('past', '2026-02-01', '2026-02-06', { res: [quick, { ...hotel, status: 'cancelled' }] })]);
    expect(result.visited.sort()).toEqual(['FR', 'US']);
    expect(result.countries.get('FR').items).toEqual([{ kind: 'res', tripKey: 'past', id: 'r1', name: 'CDG', planned: false, mine: false, lat: null, lng: null, admin1: null }]);
  });

  it('computes travel days, streak, trips this year and places', () => {
    const result = run([
      trip('a', '2024-12-30', '2025-01-02', { places: [place('x', 'FR', { ids: { osm: 'node/1' } })] }),
      trip('b', '2025-01-02', '2025-01-04', { places: [place('y', 'FR', { ids: { osm: 'node/1' } }), place('z', 'FR', { lat: 1, lng: 2 })] }),
      trip('c', '2026-10-22', '2026-10-30'),
      trip('d', '2026-12-01', '2026-12-03'),
    ]);
    // 2024-12-30..2025-01-04 (6 days, overlap merged) + 2026-10-22..today (3 days).
    expect(result.stats.travelDays).toBe(9);
    expect(result.stats.streak).toBe(3);
    expect(result.stats.tripsThisYear).toBe(1);
    expect(result.stats.places).toBe(2);
    expect(run([trip('old', '2023-05-01', '2023-05-02')]).stats.streak).toBe(0);
    expect(run([trip('last', '2025-05-01', '2025-05-02')]).stats.streak).toBe(1);
  });

  it('orders visited countries by the most recent visit, manual marks last', () => {
    const result = run([
      trip('a', '2020-01-01', '2020-01-02', { places: [place('a', 'PT')] }),
      trip('b', '2026-10-01', '2026-12-31', { places: [place('b', 'GR')] }),
      trip('c', '2023-01-01', '2023-01-05', { places: [place('c', 'PT'), place('d', 'MA')] }),
    ], { marks: { visited: { CL: 'manual' } } });
    expect(result.visited).toEqual(['GR', 'MA', 'PT', 'CL']);
    expect(result.countries.get('GR').last).toBe(TODAY);
    expect(result.countries.get('PT').last).toBe('2023-01-05');
  });

  it('counts trips without a local replica but not their places', () => {
    const result = run([trip('far', '2025-01-01', '2025-01-02', { cached: false, places: [place('x', 'FR')] })]);
    expect(result).toMatchObject({ uncached: 1, visited: [] });
    expect(result.stats.trips).toBe(1);
  });

  it('classifies trip phases and formats local dates', () => {
    expect(tripPhase({ start: TODAY }, TODAY)).toBe('started');
    expect(tripPhase({ start: '2026-10-25' }, TODAY)).toBe('future');
    expect(tripPhase({ start: null }, TODAY)).toBe('undated');
    expect(localToday(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
    expect(() => aggregateAtlas({ today: 'today' })).toThrow(RangeError);
  });
});

describe('atlas inputs', () => {
  it('reads replica entities with queued edits applied', () => {
    const record = {
      rev: 7,
      confirmed: {
        'meta:meta': { id: 'meta', title: 'Spain', start: '2026-01-01' },
        'place:p1': { id: 'p1', name: 'Prado', cc: 'ES' },
        'place:p2': { id: 'p2', name: 'Gone', cc: 'PT' },
        'place:p3': { id: 'p3', deleted: true },
        'day:d1': { id: 'd1' },
      },
      pending: [
        { op: { t: 'place', id: 'p1', set: { [`visited.${UID}`]: true } } },
        { op: { t: 'place', id: 'p2', del: true } },
        { op: { t: 'place', id: 'p4', put: { name: 'New', cc: 'FR' } } },
        { op: { do: 'trip.redate', args: {} }, effects: [{ t: 'meta', id: 'meta', set: { start: '2026-02-01' } }] },
      ],
    };
    const replica = replicaEntities(record);
    expect(replica.rev).toBe(7);
    expect(replica.meta.start).toBe('2026-02-01');
    expect(replica.places.map((item) => item.id)).toEqual(['p1', 'p4']);
    expect(replica.places[0].visited).toEqual({ [UID]: true });
    expect(replicaEntities(undefined)).toBeNull();
  });

  it('prefers a head newer than the replica for title and dates', () => {
    const entry = { ref: { w: 'trips-aaaaaaaaaa', s: 'abc', k: 'trip' }, role: 'editor', title: 'Index', start: '2026-01-01' };
    const replica = { rev: 3, meta: { title: 'Replica', start: '2026-02-01', end: '2026-02-03' }, places: [], res: [] };
    expect(tripInput(entry, replica)).toMatchObject({ title: 'Replica', start: '2026-02-01', end: '2026-02-03', cached: true });
    expect(tripInput(entry, replica, { rev: 3, title: 'Head', start: '2026-03-01', end: null, role: 'viewer' })).toMatchObject({ title: 'Replica', start: '2026-02-01' });
    expect(tripInput(entry, replica, { rev: 4, title: 'Head', start: '2026-03-01', end: null, role: 'viewer' })).toMatchObject({ title: 'Head', start: '2026-03-01', end: null, role: 'viewer' });
    expect(tripInput(entry, null)).toMatchObject({ title: 'Index', start: '2026-01-01', end: null, cached: false });
  });

  it('normalizes marks and writes them by path', async () => {
    expect(normalizeMarks({ visited: { FR: 'manual', re: 'manual', RE: 'manual', DE: 3 }, hidden: { IT: true, ES: 'yes' }, regions: { 'FR-75': 'manual', fr: 'manual', 'DE-BY': 1 } })).toEqual({ visited: { FR: 'manual' }, hidden: { IT: true }, regions: { 'FR-75': 'manual' } });
    const puter = { kv: { update: vi.fn(async () => ({ visited: { FR: 'manual' } })), remove: vi.fn(async () => ({ visited: { FR: 'manual' } })) } };
    const personal = { refresh: vi.fn(async () => ({ visited: { FR: 'manual' }, hidden: {} })) };
    const marks = await writeMarks({ puter, personal, changes: { 'visited.FR': 'manual', 'hidden.FR': null } });
    expect(puter.kv.update).toHaveBeenCalledWith('me:atlas', { 'visited.FR': 'manual' });
    expect(puter.kv.remove).toHaveBeenCalledWith('me:atlas', 'hidden.FR');
    expect(marks).toEqual({ visited: { FR: 'manual' }, hidden: {}, regions: {} });
    await expect(writeMarks({ puter, personal, changes: { 'visited.__proto__': 'manual' } })).rejects.toThrow(RangeError);
    await expect(writeMarks({ puter, personal, changes: { 'regions.FR-75.x': 'manual' } })).rejects.toThrow(RangeError);
    await writeMarks({ puter, personal, changes: { 'regions.FR-75': 'manual', 'visited.FR': 'manual' } });
    expect(puter.kv.update).toHaveBeenLastCalledWith('me:atlas', { 'regions.FR-75': 'manual', 'visited.FR': 'manual' });
  });
});

describe('atlas geography', () => {
  const topology = JSON.parse(readFileSync(new URL('../../public/data/countries-50m.json', import.meta.url), 'utf8'));
  const raw = topologyFeatures(topology, 'countries');
  const features = splitAntimeridian(raw);
  const jumps = (collection) => collection.features.flatMap((feature) => {
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    return polygons.flat().some((ring) => ring.some((point, i) => i > 0 && Math.abs(point[0] - ring[i - 1][0]) > 180)) ? [feature.properties.name] : [];
  });

  it('maps every numbered feature to a country with a continent', () => {
    for (const feature of raw.features) {
      const code = featureCode(feature);
      if (feature.id === undefined && feature.properties.name !== 'Kosovo') { expect(code).toBeNull(); continue; }
      expect(COUNTRY_CODES).toContain(code);
      expect(continentOf(code)).toBeTruthy();
    }
    expect(countryCode('gp')).toBe('FR');
    expect(countryCode('XX')).toBeNull();
    expect(searchText('Côte d’Ivoire')).toBe('cote d’ivoire');
  });

  it('splits rings that cross the antimeridian', () => {
    expect(jumps(raw).sort()).toEqual(['Antarctica', 'Fiji', 'Russia']);
    expect(jumps(features)).toEqual(['Antarctica']);
    const square = [[[170, 10], [-170, 10], [-170, 20], [170, 20], [170, 10]]];
    const parts = splitPolygon(square);
    expect(parts).toHaveLength(2);
    expect(parts.flat(2).every(([x]) => Math.abs(x) >= 170)).toBe(true);
  });

  it('locates points, enclaves and near-shore spots', () => {
    const locate = createLocator(features);
    expect(locate(48.85, 2.35)).toBe('FR');
    expect(locate(66.16, -169.8)).toBe('RU');
    expect(locate(64.73, 177.5)).toBe('RU');
    expect(locate(-16.85, -179.95)).toBe('FJ');
    expect(locate(43.94, 12.45)).toBe('SM');
    expect(locate(42.66, 21.16)).toBe('XK');
    expect(locate(-21.1, 55.5)).toBe('FR');
    expect(locate(43.69, 7.27)).toBe('FR');
    expect(locate(30, -40)).toBeNull();
    expect(locate(Number.NaN, 0)).toBeNull();
  });
});
