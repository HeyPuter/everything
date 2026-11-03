// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildTopology, groupRegions, regionCode, simplifyArc } from '../../scripts/build-regions.mjs';
import { decodeRegions, loadRegionIndex, loadRegions, locatePlace, resetBoundaries } from '../../src/lib/atlas/boundaries.js';
import { aggregateRegions, isRegionCode, regionCountry, regionTotals } from '../../src/lib/atlas/regions.js';
import { aggregateAtlas } from '../../src/lib/atlas/aggregate.js';
import { COUNTRY_CODES, FOLDED, alpha2FromNumeric, featureCode, numericTable } from '../../src/lib/atlas/countries.js';
import { topologyFeatures } from '../../src/map/topology.js';

const DATA = `${process.cwd()}/public/data`;
const readJSON = (path) => JSON.parse(readFileSync(`${DATA}/${path}`, 'utf8'));
const fetch = async (url) => {
  const path = new URL(url).pathname.replace(/^\/data\//, '');
  try { return new Response(readFileSync(`${DATA}/${path}`, 'utf8'), { status: 200 }); } catch { return new Response('', { status: 404 }); }
};
const square = (x, y, size = 1) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];

describe('region builder', () => {
  it('reads ISO and Natural Earth pseudo codes', () => {
    expect(regionCode({ iso_3166_2: 'FR-75' })).toEqual({ code: 'FR-75', iso: true });
    expect(regionCode({ iso_3166_2: 'XK-X02~' })).toEqual({ code: 'XK-X02', iso: false });
    expect(regionCode({ iso_3166_2: 'AI-X00' })).toEqual({ code: 'AI-X00', iso: false });
    expect(regionCode({ iso_3166_2: '-99-X16~' })).toBeNull();
    expect(regionCode({})).toBeNull();
  });

  it('shares a common border as one arc, so neighbours decode to the same edge', () => {
    const topology = buildTopology([
      { code: 'AA-1', name: 'West', iso: true, polygons: [[square(0, 0)]] },
      { code: 'AA-2', name: 'East', iso: true, polygons: [[square(1, 0)]] },
    ], { tolerance: 0 });
    const [west, east] = topology.objects.regions.geometries;
    const shared = west.arcs[0].filter((index) => east.arcs[0].includes(~index) || east.arcs[0].includes(index));
    expect(shared).toHaveLength(1);
    const features = topologyFeatures(topology, 'regions').features;
    const edge = (ring) => [...new Set(ring.filter(([x]) => x === 1).map((point) => point.join(',')))].sort();
    expect(edge(features[0].geometry.coordinates[0])).toEqual(['1,0', '1,1']);
    expect(edge(features[1].geometry.coordinates[0])).toEqual(['1,0', '1,1']);
    expect(features.map((feature) => feature.id)).toEqual(['AA-1', 'AA-2']);
  });

  it('dedupes an enclave ring and keeps tiny islands as triangles', () => {
    const outer = { code: 'AA-1', name: 'Outer', iso: true, polygons: [[square(0, 0, 4), square(1, 1, 1).slice().reverse()]] };
    const inner = { code: 'AA-2', name: 'Inner', iso: true, polygons: [[square(1, 1, 1)]] };
    const topology = buildTopology([outer, inner], { tolerance: 0 });
    expect(topology.arcs).toHaveLength(2);
    const ring = [[0, 0], [5, 0], [10, 1], [5, 2], [0, 0]];
    expect(simplifyArc(ring, 50)).toHaveLength(4);
    expect(simplifyArc([[0, 0], [5, 1], [10, 0]], 2)).toEqual([[0, 0], [10, 0]]);
    expect(simplifyArc([[0, 0], [5, 5], [10, 0]], 2)).toEqual([[0, 0], [5, 5], [10, 0]]);
  });

  it('groups features by atlas country and merges shared ISO codes', () => {
    const feature = (props, x) => ({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [square(x, 0)] } });
    const { countries, skipped } = groupRegions({ type: 'FeatureCollection', features: [
      feature({ iso_a2: 'FR', iso_3166_2: 'FR-GF', name: 'Guyane française', name_en: 'French Guiana' }, 0),
      feature({ iso_a2: 'GF', iso_3166_2: 'FR-973', name: 'Elsewhere' }, 2),
      feature({ iso_a2: 'PH', iso_3166_2: 'PH-MNL', name: 'Manila', region: 'Metropolitan Manila', area_sqkm: 40 }, 4),
      feature({ iso_a2: 'PH', iso_3166_2: 'PH-MNL', name: 'Quezon City', region: 'Metropolitan Manila', area_sqkm: 160 }, 5),
      feature({ iso_a2: '-1', iso_3166_2: '-99-X04~', name: 'Northern Cyprus' }, 6),
      feature({ iso_a2: 'AQ', iso_3166_2: 'AQ-X01~', name: 'Antarctica' }, 7),
    ] });
    expect([...countries.keys()]).toEqual(['FR', 'PH']);
    expect(countries.get('FR').map((region) => [region.code, region.name, region.local])).toEqual([['FR-973', 'Elsewhere', 'Elsewhere'], ['FR-GF', 'French Guiana', 'Guyane française']]);
    expect(countries.get('PH')).toHaveLength(1);
    expect(countries.get('PH')[0]).toMatchObject({ code: 'PH-MNL', name: 'Metropolitan Manila', local: null });
    expect(countries.get('PH')[0].polygons).toHaveLength(2);
    expect(skipped).toHaveLength(2);
  });
});

describe('bundled regions', () => {
  beforeEach(() => { resetBoundaries(); globalThis.location ??= { href: 'http://localhost/' }; });

  it('ships one file per indexed country, with matching counts', () => {
    const index = readJSON('regions/index.json');
    const files = readdirSync(`${DATA}/regions`).filter((name) => name !== 'index.json').map((name) => name.slice(0, 2)).sort();
    expect(files).toEqual(Object.keys(index.countries).sort());
    expect(index.countries.FR).toBe(101);
    expect(index.countries.AQ).toBeUndefined();
    expect(index.moved).toMatchObject({ 'US-PR': 'PR', 'NL-SX': 'SX' });
    for (const cc of ['FR', 'US', 'JP', 'RU']) {
      const decoded = decodeRegions(cc, readJSON(`regions/${cc}.json`));
      expect(decoded.regions).toHaveLength(index.countries[cc]);
      expect(decoded.regions.every((region) => isRegionCode(region.code))).toBe(true);
    }
    expect(Math.max(...files.map((cc) => readFileSync(`${DATA}/regions/${cc}.json`).length))).toBeLessThan(200_000);
  });

  it('locates places to a country and an ISO region offline', async () => {
    const cases = [
      [48.8566, 2.3522, 'FR', 'FR-75'], [45.764, 4.8357, 'FR', 'FR-69'], [-20.8821, 55.4507, 'FR', 'FR-RE'],
      [40.7128, -74.006, 'US', 'US-NY'], [37.7749, -122.4194, 'US', 'US-CA'], [21.3069, -157.8583, 'US', 'US-HI'],
      [35.6762, 139.6503, 'JP', 'JP-13'], [-33.8688, 151.2093, 'AU', 'AU-NSW'], [64.7337, 177.5089, 'RU', 'RU-CHU'],
      [18.4655, -66.1057, 'PR', 'US-PR'], [42.6629, 21.1655, 'XK', null], [0, -30, null, null],
    ];
    for (const [lat, lng, cc, admin1] of cases) expect(await locatePlace(lat, lng, { fetch })).toEqual({ cc, admin1 });
    expect(await locatePlace(Number.NaN, 2, { fetch })).toEqual({ cc: null, admin1: null });
  });

  it('loads a country once and answers null where the dataset has no regions', async () => {
    let calls = 0;
    const counting = async (url) => { calls += 1; return fetch(url); };
    const [a, b] = await Promise.all([loadRegions('DE', { fetch: counting }), loadRegions('DE', { fetch: counting })]);
    expect(a).toBe(b);
    expect(calls).toBe(2);
    expect(await loadRegions('AQ', { fetch: counting })).toBeNull();
    expect(await loadRegions('zz', { fetch: counting })).toBeNull();
    expect((await loadRegionIndex({ fetch })).moved['UA-43']).toBe('RU');
  });
});

describe('region aggregation', () => {
  const regions = [{ code: 'FR-75', name: 'Paris' }, { code: 'FR-69', name: 'Rhône' }, { code: 'FR-06', name: 'Alpes-Maritimes' }, { code: 'FR-13', name: 'Bouches-du-Rhône' }];
  const locate = (lat) => (lat > 48 ? 'FR-75' : lat > 45 ? 'FR-69' : lat > 43.6 ? 'FR-06' : null);
  const item = (extra) => ({ kind: 'place', tripKey: 't', id: 'x', name: 'x', planned: false, lat: null, lng: null, admin1: null, ...extra });

  it('counts items by admin1 first, then coordinates, and adds manual marks', () => {
    const country = { status: 'visited', items: [
      item({ admin1: 'FR-13', lat: 48.8, lng: 2.3 }),
      item({ lat: 48.85, lng: 2.35 }),
      item({ lat: 43.7, lng: 7.26, planned: true }),
      item({ admin1: 'FR-99', lat: 10, lng: 10 }),
    ] };
    const result = aggregateRegions({ country, regions, marks: { regions: { 'FR-69': 'manual', 'DE-BY': 'manual' } }, locate });
    expect(result).toMatchObject({ total: 4, visited: 3, planned: 1 });
    expect(result.byCode.get('FR-13')).toMatchObject({ status: 'visited', auto: true, manual: false });
    expect(result.byCode.get('FR-75').items).toHaveLength(1);
    expect(result.byCode.get('FR-69')).toMatchObject({ status: 'visited', manual: true, auto: false });
    expect(result.byCode.get('FR-06').status).toBe('planned');
  });

  it('ignores a hidden country’s trips but keeps manual marks', () => {
    const country = { status: 'hidden', items: [item({ lat: 48.85, lng: 2.35 })] };
    const result = aggregateRegions({ country, regions, marks: { regions: { 'FR-06': 'manual' } }, locate });
    expect(result.visited).toBe(1);
    expect(result.byCode.get('FR-75').status).toBeNull();
  });

  it('totals loaded countries exactly and the rest by manual marks', () => {
    const atlas = aggregateAtlas({ today: '2026-10-24', trips: [
      { key: 'a', start: '2025-01-01', end: '2025-01-05', cached: true, places: [{ id: 'p', name: 'Louvre', cc: 'FR', lat: 48.86, lng: 2.34 }, { id: 'q', name: 'Prado', cc: 'ES', lat: 40.41, lng: -3.69 }], res: [] },
    ] });
    const loaded = new Map([['FR', { regions, locate }]]);
    const marks = { regions: { 'FR-06': 'manual', 'US-CA': 'manual', 'UA-43': 'manual' } };
    const totals = regionTotals({ atlas, loaded, marks, moved: { 'UA-43': 'RU' } });
    expect(totals).toMatchObject({ regions: 4, countries: 3, pending: 1 });
    expect(totals.byCountry.get('FR').visited).toBe(2);
    expect(regionCountry('UA-43', { 'UA-43': 'RU' })).toBe('RU');
    expect(regionCountry('FR-GF')).toBe('FR');
    expect(regionCountry('FR')).toBeNull();
  });
});

describe('numeric country table', () => {
  it('maps ISO 3166-1 numeric codes to alpha-2', () => {
    expect(alpha2FromNumeric('250')).toBe('FR');
    expect(alpha2FromNumeric(76)).toBe('BR');
    expect(alpha2FromNumeric('076')).toBe('BR');
    expect(alpha2FromNumeric('840')).toBe('US');
    expect(alpha2FromNumeric('826')).toBe('GB');
    expect(alpha2FromNumeric('643')).toBe('RU');
    expect(alpha2FromNumeric('156')).toBe('CN');
    expect(alpha2FromNumeric('356')).toBe('IN');
    expect(alpha2FromNumeric('036')).toBe('AU');
    expect(alpha2FromNumeric('710')).toBe('ZA');
    expect(alpha2FromNumeric('158')).toBe('TW');
    expect(alpha2FromNumeric('-99')).toBeNull();
    expect(alpha2FromNumeric(1.5)).toBeNull();
    expect(alpha2FromNumeric('9999')).toBeNull();
    expect(alpha2FromNumeric(null)).toBeNull();
  });

  it('is one-to-one and covers every coded country geometry', () => {
    const table = numericTable();
    expect(new Set(table.map(([numeric]) => numeric)).size).toBe(table.length);
    expect(new Set(table.map(([, alpha2]) => alpha2)).size).toBe(table.length);
    const known = new Set([...COUNTRY_CODES, ...Object.keys(FOLDED)]);
    expect(table.filter(([, alpha2]) => !known.has(alpha2))).toEqual([]);
    const topology = readJSON('countries-50m.json');
    const features = topologyFeatures(topology, 'countries').features;
    const missing = features.filter((feature) => !featureCode(feature)).map((feature) => feature.properties.name).sort();
    expect(missing).toEqual(['Indian Ocean Ter.', 'N. Cyprus', 'Siachen Glacier', 'Somaliland']);
  });
});
