// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createServices, crossRate, dedupeResults, freezeRate, rateString, dailySummary } from '../../src/services/index.js';
import { DEFAULT_CONFIG, createMemoryCache, sanitizeConfig } from '../../src/services/core.js';
import { decodePolyline } from '../../src/services/route.js';
import { metCondition, wmoCondition } from '../../src/services/weather.js';
import { convertMinor } from '../../src/shared/money.js';

const worker = 'https://trips-geo.puter.work';
function fixture(respond, { providers = {}, keys = {}, geoWorker = worker, ...options } = {}) {
  const fetcher = vi.fn(async (url, init) => {
    const result = await respond(String(url), init);
    return result instanceof Response ? result : Response.json(result);
  });
  const services = createServices({ userId: 'alice', fetch: fetcher, cache: createMemoryCache(), keys: async provider => keys[provider] ?? null, config: { providers, disabled: [], geoWorker }, sleep: async () => {}, retries: 0, ...options });
  return { fetcher, services, urls: () => fetcher.mock.calls.map(([url]) => String(url)) };
}
const down = () => new Response('', { status: 503 });
const photonHit = { features: [{ geometry: { type: 'Point', coordinates: [13.4, 52.5] }, properties: { osm_id: 7, osm_type: 'N', osm_key: 'tourism', osm_value: 'museum', name: 'Museum', countrycode: 'de', city: 'Berlin', extent: [13, 52, 14, 53] } }] };

describe('runtime config', () => {
  it('ships a provider list for every capability and a valid geo worker setting', async () => {
    const shipped = JSON.parse(await readFile(new URL('../../public/config.json', import.meta.url), 'utf8'));
    const clean = sanitizeConfig(shipped);
    expect(Object.keys(shipped.providers).sort()).toEqual(Object.keys(DEFAULT_CONFIG.providers).sort());
    expect(clean.providers).toEqual(DEFAULT_CONFIG.providers); expect(clean.nagerVersion).toBe(4); expect(clean.disabled).toEqual([]);
    expect(shipped.geoWorker === null || /^https:\/\/[a-z0-9-]+\.puter\.work\/?$/.test(shipped.geoWorker)).toBe(true);
    expect(clean.providers.weather).toEqual(['metno']); expect(clean.providers.route.at(-1)).toBe('straight');
  });
  it('caches the configuration for an hour across adapter calls', async () => {
    let now = 0;
    const cfgFetch = vi.fn(async () => Response.json({ providers: { fx: ['frankfurter'] }, disabled: [] }));
    const live = createServices({ userId: 'alice', fetch: url => String(url) === '/config.json' ? cfgFetch() : Response.json([{ base: 'EUR', quote: 'USD', rate: 1.1, date: '2026-10-23' }]), cache: createMemoryCache(), now: () => now, retries: 0 });
    await live.fx.rates('EUR'); await live.fx.rates('USD'); expect(cfgFetch).toHaveBeenCalledOnce();
    now = 3_600_001; await live.fx.rates('GBP'); expect(cfgFetch).toHaveBeenCalledTimes(2);
  });
  it('accepts only plausible user keys and survives a failing key source', async () => {
    const values = { ors: 'ors-key-123456', short: 'abc', spaced: 'has space key', geoapify: 42 };
    const { services } = fixture(() => ({}), { keys: values });
    expect(await services.context.key('ors')).toBe('ors-key-123456');
    for (const name of ['short', 'spaced', 'geoapify', 'missing']) expect(await services.context.key(name)).toBeNull();
    const failing = createServices({ userId: 'alice', cache: createMemoryCache(), config: DEFAULT_CONFIG, keys: async () => { throw new Error('locked'); } });
    expect(await failing.context.key('ors')).toBeNull();
  });
});

describe('geocode', () => {
  it('sends Photon bias, zoom and supported language only, and tags results with their source', async () => {
    const { services, urls } = fixture(() => photonHit, { providers: { geocode: ['photon'] } });
    const result = await services.geocode.search('Museum', { lang: 'de-AT', bias: { lat: 52.12345, lng: 13.6789, zoom: 11.6 } });
    const url = new URL(urls()[0]); expect(url.searchParams.get('lang')).toBe('de'); expect(url.searchParams.get('zoom')).toBe('12'); expect(url.searchParams.get('lon')).toBe('13.679');
    expect(result.data[0]).toMatchObject({ source: 'photon', kind: { key: 'tourism', value: 'museum' }, city: 'Berlin', extent: [13, 52, 14, 53], osm: { type: 'node', id: '7' } });
    await services.geocode.search('Museo', { lang: 'es' }); expect(new URL(urls()[1]).searchParams.has('lang')).toBe(false);
  });
  it('falls back from Photon to Nominatim through the geo worker for submitted searches only', async () => {
    const respond = url => url.startsWith('https://photon') ? down() : [{ lat: '48.85', lon: '2.35', osm_type: 'relation', osm_id: 7444, name: 'Paris', display_name: 'Paris, France', address: { country_code: 'fr' }, extratags: { wikidata: 'Q90' }, category: 'boundary', type: 'administrative' }];
    const { services, urls } = fixture(respond, { providers: { geocode: ['photon', 'nominatim'] } });
    const result = await services.geocode.search('Paris', { bbox: [2.1, 48.7, 2.6, 49.0] });
    expect(result.provider).toBe('nominatim'); expect(result.data[0]).toMatchObject({ id: 'R:7444', source: 'nominatim', wikidata: 'Q90', country: 'FR' });
    expect(urls()[1]).toBe(`${worker}/nominatim/search?q=Paris&lang=en&viewbox=2.1%2C48.7%2C2.6%2C49`);
    expect(await services.geocode.autocomplete('Paris')).toBeNull(); expect(urls().filter(url => url.includes('nominatim'))).toHaveLength(1);
  });
  it('uses a Geoapify key only when configured and present', async () => {
    const respond = url => url.startsWith('https://photon') ? down() : { results: [{ lat: 1, lon: 2, name: 'Keyed', formatted: 'Keyed, X', country_code: 'fr', datasource: { raw: { osm_id: 5, osm_type: 'n' } } }] };
    const off = fixture(respond, { providers: { geocode: ['photon'] }, keys: { geoapify: 'secret-key-1' } });
    expect(await off.services.geocode.search('Keyed')).toBeNull();
    const none = fixture(respond, { providers: { geocode: ['photon', 'geoapify'] } });
    expect(await none.services.geocode.search('Keyed')).toBeNull(); expect(none.urls().some(url => url.includes('geoapify'))).toBe(false);
    const keyed = fixture(respond, { providers: { geocode: ['photon', 'geoapify'] }, keys: { geoapify: 'secret-key-1' } });
    const result = await keyed.services.geocode.search('Keyed', { bias: { lat: 1, lng: 2 } });
    expect(result).toMatchObject({ provider: 'geoapify', data: [{ id: 'N:5', source: 'geoapify' }] }); expect(result.attribution[0].text).toContain('Geoapify');
    const url = new URL(keyed.urls()[1]); expect(url.searchParams.get('apiKey')).toBe('secret-key-1'); expect(url.searchParams.get('bias')).toBe('proximity:2,1');
    expect(JSON.stringify(result)).not.toContain('secret-key-1');
  });
  it('reverse geocodes through Photon then the geo worker with rounded coordinates', async () => {
    const { services, urls } = fixture(url => url.startsWith('https://photon') ? down() : { lat: '1', lon: '2', osm_type: 'way', osm_id: 3, display_name: 'Road' }, { providers: { geocode: ['photon', 'nominatim'] } });
    const result = await services.geocode.reverse(1.123456789, 2.987654321, { lang: 'fr' });
    expect(result).toMatchObject({ provider: 'nominatim', data: [{ id: 'W:3' }] }); expect(urls()[1]).toBe(`${worker}/nominatim/reverse?lat=1.12346&lon=2.98765&lang=fr`);
  });
  it('queries POI categories with Photon include filters, keeps results inside the box and caches for a day', async () => {
    let now = 0; const hits = { features: [...photonHit.features, { geometry: { type: 'Point', coordinates: [20, 52.5] }, properties: { osm_id: 8, osm_type: 'N', name: 'Outside' } }] };
    const { services, urls, fetcher } = fixture(() => hits, { providers: { pois: ['photon'] }, now: () => now });
    const result = await services.geocode.pois([13, 52, 14, 53], 'museum');
    const url = new URL(urls()[0]); expect(url.searchParams.get('include')).toBe('osm.tourism.museum,osm.tourism.gallery'); expect(url.searchParams.has('q')).toBe(false); expect(url.searchParams.get('bbox')).toBe('13,52,14,53');
    expect(result.data.map(item => item.name)).toEqual(['Museum']);
    await services.geocode.pois([13, 52, 14, 53], 'museum'); expect(fetcher).toHaveBeenCalledOnce();
    now = 86_400_001; await services.geocode.pois([13, 52, 14, 53], 'museum'); expect(fetcher).toHaveBeenCalledTimes(2);
    await services.geocode.pois([13, 52, 14, 53], 'hotel'); expect(new URL(urls()[2]).searchParams.get('include')).toContain('osm.tourism.hostel');
    expect(() => services.geocode.pois([13, 52, 16, 53], 'food')).toThrow(); expect(() => services.geocode.search('x', { category: 'nope' })).toThrow();
  });
  it('tries the next provider on an empty answer and caches the empty list only when every provider is empty', async () => {
    const { services, urls, fetcher } = fixture(url => url.startsWith('https://photon') ? { features: [] } : [], { providers: { geocode: ['photon', 'nominatim'] } });
    const empty = await services.geocode.search('Nowhere');
    expect(empty).toMatchObject({ provider: 'photon', data: [] }); expect(urls()).toHaveLength(2);
    await services.geocode.search('Nowhere'); expect(fetcher).toHaveBeenCalledTimes(2);
    const second = fixture(url => url.startsWith('https://photon') ? { features: [] } : [{ lat: '1', lon: '1', osm_type: 'node', osm_id: 1, name: 'Found' }], { providers: { geocode: ['photon', 'nominatim'] } });
    expect((await second.services.geocode.search('Found')).provider).toBe('nominatim');
  });
  it('keeps an empty answer only an hour when a later provider failed', async () => {
    let now = 0; const respond = url => url.startsWith('https://photon') ? { features: [] } : new Response('', { status: 429 });
    const { services, fetcher } = fixture(respond, { providers: { geocode: ['photon', 'nominatim'] }, now: () => now });
    expect((await services.geocode.search('Nowhere')).data).toEqual([]); expect(fetcher).toHaveBeenCalledTimes(2);
    now = 3_600_000 - 1; await services.geocode.search('Nowhere'); expect(fetcher).toHaveBeenCalledTimes(2);
    now = 3_600_001; await services.geocode.search('Nowhere'); expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('retries category searches with osm_tag filters as well', async () => {
    const { services, urls } = fixture(url => url.includes('include=') ? new Response('', { status: 400 }) : photonHit, { providers: { geocode: ['photon', 'nominatim'] } });
    expect((await services.geocode.search('Louvre', { category: 'museum' })).provider).toBe('photon');
    const legacy = new URL(urls()[1]); expect(legacy.searchParams.getAll('q')).toEqual(['Louvre']); expect(legacy.searchParams.getAll('osm_tag')).toEqual(['tourism:museum', 'tourism:gallery']);
  });
  it('falls back to legacy osm_tag filters when Photon rejects category includes', async () => {
    const { services, urls } = fixture(url => url.includes('include=') ? new Response('', { status: 400 }) : photonHit, { providers: { pois: ['photon'] } });
    expect((await services.geocode.pois([13, 52, 14, 53], 'museum')).data).toHaveLength(1);
    const legacy = new URL(urls()[1]); expect(legacy.searchParams.getAll('osm_tag')).toEqual(['tourism:museum', 'tourism:gallery']); expect(legacy.searchParams.get('q')).toBe('museum');
  });
  it('rounds bias boxes outward and leaves OSM references empty when a provider has none', async () => {
    const { services, urls } = fixture(() => ({ results: [{ lat: 1, lon: 2, name: 'No OSM', place_id: 'abc' }] }), { providers: { geocode: ['geoapify'] }, keys: { geoapify: 'secret-key-1' } });
    const result = await services.geocode.search('No OSM', { bbox: [13.40001, 52.50001, 13.40002, 52.50002] });
    expect(result.data[0]).toMatchObject({ id: 'geoapify:abc', osm: null }); expect(new URL(urls()[0]).searchParams.get('filter')).toBe('rect:13.4,52.5,13.401,52.501');
  });
  it('refuses forbidden provider hosts including their subdomains', async () => {
    const { services } = fixture(() => ({}));
    for (const url of ['https://a.tile.openstreetmap.org/0/0/0.png', 'https://www.overpass-api.de/api', 'https://router.project-osrm.org/x']) await expect(services.context.json(url)).rejects.toThrow('refused');
  });
  it('dedupes same-name results within 60 m across sources', () => {
    const list = [{ name: 'Café Ö', lat: 52.5, lng: 13.4, source: 'photon' }, { name: 'cafe o', lat: 52.5003, lng: 13.4, source: 'nominatim' }, { name: 'Café Ö', lat: 52.51, lng: 13.4, source: 'nominatim' }, { name: 'Other', lat: 52.5, lng: 13.4 }];
    expect(dedupeResults(list).map(item => item.source ?? item.name)).toEqual(['photon', 'nominatim', 'Other']);
  });
});

describe('routing', () => {
  const osrm = { code: 'Ok', routes: [{ distance: 1000, duration: 100, geometry: { type: 'LineString', coordinates: [[0, 0], [0.5, 0], [1, 0]] }, legs: [{ distance: 400, duration: 40 }, { distance: 600, duration: 60 }] }] };
  it('routes through OSRM on the geo worker with per-leg metrics and a seven day cache', async () => {
    let now = 0; const { services, fetcher } = fixture(() => osrm, { providers: { route: ['geo-osrm', 'straight'] }, now: () => now });
    const result = await services.route.route([[0, 0], [0.5, 0], [1, 0]], 'bike');
    expect(result.data).toMatchObject({ distance: 1000, estimated: false, avoidsApplied: true, legs: [{ distance: 400 }, { distance: 600 }] });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ points: [[0, 0], [0.5, 0], [1, 0]], mode: 'bike' });
    now = 7 * 86_400_000 - 1; await services.route.route([[0, 0], [0.5, 0], [1, 0]], 'bike'); expect(fetcher).toHaveBeenCalledOnce();
    now += 2; await services.route.route([[0, 0], [0.5, 0], [1, 0]], 'bike'); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('uses Valhalla for avoid options, then the user ORS key, then a flagged straight line', async () => {
    const valhalla = { trip: { status: 0, summary: { length: 2.5, time: 300 }, legs: [{ shape: '??_ibE?', summary: { length: 2.5, time: 300 } }] } };
    const respond = (url, init) => url.endsWith('/valhalla') ? (JSON.parse(init.body).avoid.length ? valhalla : down()) : down();
    const { services, fetcher } = fixture(respond, { providers: { route: ['geo-osrm', 'geo-valhalla', 'ors', 'straight'] } });
    const avoided = await services.route.route([[0, 0], [1, 0]], 'drive', { avoid: ['toll', 'toll', 'ferry'] });
    expect(avoided).toMatchObject({ provider: 'geo-valhalla', data: { distance: 2500, duration: 300, avoidsApplied: true, estimated: false } });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ points: [[0, 0], [1, 0]], mode: 'drive', avoid: ['ferry', 'toll'] });
    expect(avoided.attribution[0].text).toContain('Valhalla');
    const plain = await services.route.route([[0, 0], [1, 0]], 'walk');
    expect(plain).toMatchObject({ provider: 'straight', data: { estimated: true, avoidsApplied: true } });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([`${worker}/valhalla`, `${worker}/route`]);
    const ors = { features: [{ geometry: { type: 'LineString', coordinates: [[0, 0], [1, 0]] }, properties: { summary: { distance: 3000, duration: 400 } } }] };
    const chain = fixture(url => url.includes('openrouteservice') ? ors : down(), { providers: { route: ['geo-osrm', 'geo-valhalla', 'ors', 'straight'] }, keys: { ors: 'ors-key-123456' } });
    expect(await chain.services.route.route([[0, 0], [1, 0]], 'drive', { avoid: ['motorway'] })).toMatchObject({ provider: 'ors', data: { distance: 3000, avoidsApplied: true } });
    expect(chain.urls()).toEqual([`${worker}/valhalla`, 'https://api.openrouteservice.org/v2/directions/driving-car/geojson']);
  });
  it('serves an expired real route as stale instead of replacing it with an estimate', async () => {
    let now = 0; let up = true;
    const osrm = { code: 'Ok', routes: [{ distance: 9, duration: 9, geometry: '??_ibE?' }] };
    const { services, fetcher } = fixture(() => up ? osrm : new Response('', { status: 429 }), { providers: { route: ['geo-osrm', 'straight'] }, now: () => now });
    expect((await services.route.route([[0, 0], [0, 0.1]], 'drive')).provider).toBe('geo-osrm');
    up = false; now = 7 * 86_400_000 + 1;
    expect(await services.route.route([[0, 0], [0, 0.1]], 'drive')).toMatchObject({ provider: 'geo-osrm', stale: true, data: { estimated: false } });
    now += 9 * 60_000; expect(await services.route.route([[0, 0], [0, 0.1]], 'drive')).toMatchObject({ cached: true, stale: true }); expect(fetcher).toHaveBeenCalledTimes(2);
    up = true; now += 60_001; expect((await services.route.route([[0, 0], [0, 0.1]], 'drive'))).toMatchObject({ provider: 'geo-osrm', stale: false, cached: false }); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('caches straight estimates briefly and per geo worker so real routes replace them', async () => {
    let now = 0; let geoWorker = null; let failing = true;
    const osrmRoute = { code: 'Ok', routes: [{ distance: 9, duration: 9, geometry: '??_ibE?', legs: [{ distance: 9, duration: 9 }] }] };
    const fetcher = vi.fn(async () => failing ? new Response('', { status: 429 }) : Response.json(osrmRoute));
    const services = createServices({ userId: 'alice', fetch: fetcher, cache: createMemoryCache(), config: () => ({ providers: { route: ['geo-osrm', 'straight'] }, disabled: [], geoWorker }), now: () => now, retries: 0, sleep: async () => {} });
    expect((await services.route.route([[0, 0], [0, 0.1]], 'drive')).provider).toBe('straight'); expect(fetcher).not.toHaveBeenCalled();
    geoWorker = worker; expect((await services.route.route([[0, 0], [0, 0.1]], 'drive')).provider).toBe('straight'); expect(fetcher).toHaveBeenCalledOnce();
    failing = false; now = 9 * 60_000; expect((await services.route.route([[0, 0], [0, 0.1]], 'drive')).cached).toBe(true);
    now = 10 * 60_000 + 1; const routed = await services.route.route([[0, 0], [0, 0.1]], 'drive');
    expect(routed).toMatchObject({ provider: 'geo-osrm', data: { estimated: false, geometry: { coordinates: [[0, 0], [0, 0.1]] } } });
  });
  it('sends ORS requests with the user key and maps avoid features per profile', async () => {
    const ors = { features: [{ geometry: { type: 'LineString', coordinates: [[0, 0], [1, 0]] }, properties: { summary: { distance: 2000, duration: 200 }, segments: [{ distance: 2000, duration: 200 }] } }] };
    const { services, fetcher } = fixture(url => url.includes('openrouteservice') ? ors : down(), { providers: { route: ['ors', 'straight'] }, keys: { ors: 'ors-key-123456' }, geoWorker: null });
    const result = await services.route.route([[0, 0], [1, 0]], 'drive', { avoid: ['motorway', 'ferry'] });
    expect(result).toMatchObject({ provider: 'ors', data: { distance: 2000, legs: [{ duration: 200 }] } });
    const [url, init] = fetcher.mock.calls[0]; expect(String(url)).toBe('https://api.openrouteservice.org/v2/directions/driving-car/geojson');
    expect(init.headers.Authorization).toBe('ors-key-123456'); expect(JSON.parse(init.body).options.avoid_features).toEqual(['ferries', 'highways']);
    await services.route.route([[0, 0], [1, 0]], 'walk', { avoid: ['toll'] }); expect(JSON.parse(fetcher.mock.calls[1][1].body).options).toBeUndefined();
    const keyless = fixture(() => ors, { providers: { route: ['ors', 'straight'] }, geoWorker: null });
    expect((await keyless.services.route.route([[0, 0], [1, 0]])).provider).toBe('straight'); expect(keyless.fetcher).not.toHaveBeenCalled();
  });
  it('estimates straight lines at mode speed × 1.25 and supports transit only as an estimate', async () => {
    const { services, fetcher } = fixture(() => osrm, { providers: { route: ['geo-osrm', 'straight'] } });
    const walk = await services.route.route([[0, 0], [0, 1]], 'transit');
    expect(walk.data.estimated).toBe(true); expect(fetcher).not.toHaveBeenCalled();
    expect(walk.data.distance).toBeCloseTo(111_195 * 1.25, -2); expect(walk.data.duration).toBeCloseTo(walk.data.distance / (25 / 3.6), 3); expect(walk.data.legs).toHaveLength(1);
  });
  it('returns duration and distance matrices from OSRM, ORS or estimates', async () => {
    const table = { code: 'Ok', durations: [[0, 5], [6, 0]], distances: [[0, 50], [60, 0]] };
    const { services } = fixture(() => table, { providers: { route: ['geo-osrm', 'straight'] } });
    expect((await services.route.matrix([[0, 0], [1, 0]], 'drive')).data).toEqual({ durations: [[0, 5], [6, 0]], distances: [[0, 50], [60, 0]], estimated: false });
    const bad = fixture(() => ({ durations: [[0, -1], [1, 0]] }), { providers: { route: ['geo-osrm', 'straight'] } });
    const estimated = await bad.services.route.matrix([[0, 0], [1, 0]], 'walk'); expect(estimated.provider).toBe('straight'); expect(estimated.data.distances[0][1]).toBeGreaterThan(130_000);
    const ors = fixture(() => table, { providers: { route: ['ors'] }, keys: { ors: 'ors-key-123456' }, geoWorker: null });
    const viaOrs = await ors.services.route.matrix([[0, 0], [1, 0]], 'bike'); expect(viaOrs.provider).toBe('ors'); expect(String(ors.fetcher.mock.calls[0][0])).toContain('/v2/matrix/cycling-regular');
  });
  it('decodes precision-6 polylines and rejects truncated input', () => {
    expect(decodePolyline('_izlhA~rlgdF_{geC~ywl@_kwzCn`{nI')).toEqual([[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]]);
    expect(() => decodePolyline('_izlhA')).toThrow();
  });
});

describe('weather', () => {
  const openMeteo = { hourly: { time: ['2026-10-24T00:00', '2026-10-24T01:00'], temperature_2m: [10, 12], precipitation: [0.2, 0], weather_code: [61, 3], wind_speed_10m: [2, 3], relative_humidity_2m: [80, 70] } };
  it('switches to Open-Meteo only when config lists it, normalizing conditions and UTC times', async () => {
    const { services, urls } = fixture(url => url.includes('api.met.no') ? down() : openMeteo, { providers: { weather: ['metno', 'openmeteo'] } });
    const result = await services.weather.forecast(52.123456, 13.1, {});
    expect(result.provider).toBe('openmeteo'); expect(result.data.entries[0]).toMatchObject({ time: '2026-10-24T00:00:00.000Z', temperatureC: 10, condition: 'rain', periodHours: 1 });
    expect(new URL(urls()[1]).searchParams.get('latitude')).toBe('52.1235'); expect(result.attribution[0].text).toContain('Open-Meteo');
    const metOnly = fixture(url => url.includes('api.met.no') ? down() : openMeteo, { providers: { weather: ['metno'] } });
    expect(await metOnly.services.weather.forecast(52, 13)).toBeNull(); expect(metOnly.urls().every(url => url.includes('api.met.no'))).toBe(true);
  });
  it('averages Open-Meteo archive days of the month as a normals alternative', async () => {
    const daily = { time: ['2020-01-01', '2020-01-02', '2020-02-01'], temperature_2m_mean: [1, 3, 10], temperature_2m_max: [4, 6, 12], temperature_2m_min: [-2, 0, 8], precipitation_sum: [1, 2, 0] };
    const { services, urls } = fixture(url => url.includes('power.larc') ? down() : { daily }, { providers: { normals: ['nasa', 'openmeteo'] }, now: () => Date.parse('2026-10-24T00:00:00Z') });
    const result = await services.weather.normals(10.2, 20.3, 1);
    expect(result).toMatchObject({ provider: 'openmeteo', data: { temperatureC: 2, highC: 5, lowC: -1, precipitationMmDay: 1.5, lat: 10, lng: 20.5 } });
    const url = new URL(urls()[1]); expect(url.searchParams.get('start_date')).toBe('2016-01-01'); expect(url.searchParams.get('end_date')).toBe('2025-12-31');
  });
  it('maps provider symbols to shared conditions and summarizes local days', () => {
    expect(['clearsky_day', 'fair_night', 'cloudy', 'lightrain', 'rainshowers_day', 'heavysnow', 'sleet', 'rainandthunder', 'fog'].map(metCondition)).toEqual(['clear', 'partly', 'cloudy', 'drizzle', 'rain', 'snow', 'sleet', 'thunder', 'fog']);
    expect([0, 2, 3, 45, 53, 57, 63, 67, 75, 96].map(wmoCondition)).toEqual(['clear', 'partly', 'cloudy', 'fog', 'drizzle', 'sleet', 'rain', 'sleet', 'snow', 'thunder']);
    const days = dailySummary([
      { time: '2026-10-24T22:00:00Z', temperatureC: 5, precipitationMm: 1, condition: 'rain' },
      { time: '2026-10-24T23:00:00Z', temperatureC: 4, precipitationMm: 0.5, condition: 'rain' },
      { time: '2026-10-25T01:00:00Z', temperatureC: 2, precipitationMm: null, condition: 'clear' },
    ], 'Asia/Tokyo');
    expect(days).toEqual([{ date: '2026-10-25', minC: 2, maxC: 5, precipitationMm: 1.5, condition: 'rain' }]);
  });
});

describe('exchange rates', () => {
  it('falls back from jsDelivr to the Cloudflare mirror within the CC0 provider', async () => {
    const respond = url => url.includes('frankfurter') || url.includes('jsdelivr') ? down() : { date: '2026-10-20', eur: { usd: 1.1 } };
    const { services, urls } = fixture(respond, { providers: { fx: ['frankfurter', 'fawaz'] } });
    const result = await services.fx.rates('EUR', '2026-10-20');
    expect(result).toMatchObject({ provider: 'fawaz', data: { date: '2026-10-20', rates: { EUR: 1, USD: 1.1 } } });
    expect(urls()[2]).toBe('https://2026-10-20.currency-api.pages.dev/v1/currencies/eur.json');
  });
  it('keeps dated rates for a year only once they are final', async () => {
    let now = Date.parse('2026-10-24T08:00:00Z'); let effective = '2026-10-23';
    const { services, fetcher } = fixture(() => [{ base: 'EUR', quote: 'USD', rate: 1.1, date: effective }], { providers: { fx: ['frankfurter'] }, now: () => now });
    await services.fx.rates('EUR', '2026-10-24'); now += 12 * 3_600_000 + 1; effective = '2026-10-24';
    await services.fx.rates('EUR', '2026-10-24'); expect(fetcher).toHaveBeenCalledTimes(2);
    now += 100 * 86_400_000; await services.fx.rates('EUR', '2026-10-24'); expect(fetcher).toHaveBeenCalledTimes(2);
    await services.fx.rates('EUR', '2026-01-03'); now += 13 * 3_600_000; effective = '2026-01-02'; await services.fx.rates('EUR', '2026-01-03'); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('freezes cross rates as decimal strings for expenses', () => {
    const result = { provider: 'frankfurter', data: { base: 'EUR', date: '2026-10-23', rates: { EUR: 1, USD: 1.25, JPY: 160, VND: 27000 } } };
    expect(crossRate(result.data, 'USD', 'JPY')).toBe(128); expect(crossRate(result.data, 'EUR', 'XXX')).toBeNull();
    const frozen = freezeRate(result, 'USD', 'EUR'); expect(frozen).toEqual({ rate: '0.8', from: 'USD', to: 'EUR', date: '2026-10-23', provider: 'frankfurter' });
    expect(convertMinor(1000, frozen.rate, 'USD', 'EUR')).toBe(800);
    expect(freezeRate(result, 'VND', 'EUR').rate).toBe('0.0000370370370370'.replace(/0+$/, '')); expect(convertMinor(2_700_000, freezeRate(result, 'VND', 'JPY').rate, 'VND', 'JPY')).toBe(16_000);
    expect(rateString(0)).toBeNull(); expect(rateString(1e-30)).toBeNull(); expect(rateString(123456.789)).toBe('123456.789');
  });
});

describe('holidays', () => {
  it('falls back to OpenHolidays public holidays, expanding ranges and filtering regions', async () => {
    const rows = [{ id: '1', startDate: '2026-12-24', endDate: '2026-12-26', nationwide: true, name: [{ language: 'EN', text: 'Christmas' }, { language: 'DE', text: 'Weihnachten' }] }, { id: '2', startDate: '2026-11-01', endDate: '2026-11-01', nationwide: false, subdivisions: [{ code: 'DE-BY' }], name: [{ language: 'EN', text: 'All Saints' }] }, { id: '3', startDate: '2026-01-06', endDate: '2026-01-06', nationwide: false, subdivisions: [{ code: 'DE-BW' }], name: [{ language: 'EN', text: 'Epiphany' }] }];
    const { services, urls } = fixture(url => url.includes('nager') ? down() : rows, { providers: { publicHolidays: ['nager', 'openholidays'] } });
    const result = await services.holidays.public('DE', 2026, 'DE-BY', { lang: 'de' });
    expect(result.provider).toBe('openholidays'); expect(result.data.map(day => [day.date, day.name])).toEqual([['2026-11-01', 'All Saints'], ['2026-12-24', 'Weihnachten'], ['2026-12-25', 'Weihnachten'], ['2026-12-26', 'Weihnachten']]);
    expect(result.data[1].localName).toBe('Weihnachten'); expect(urls()[0]).toBe('https://nagerholidays.com/api/v4/Holidays/DE/2026');
  });
  it('lists subdivisions and localizes school holiday names', async () => {
    const respond = url => url.includes('Subdivisions') ? [{ code: 'DE-BY', name: [{ language: 'EN', text: 'Bavaria' }, { language: 'DE', text: 'Bayern' }], children: [{ code: 'DE-BY-X', name: [] }] }, { code: '<bad>' }] : [{ id: 's', startDate: '2026-08-03', endDate: '2026-09-14', name: [{ language: 'DE', text: 'Sommerferien' }, { language: 'EN', text: 'Summer' }], subdivisions: [{ code: 'DE-BY' }] }];
    const { services } = fixture(respond, { providers: { subdivisions: ['openholidays'], schoolHolidays: ['openholidays'] } });
    expect((await services.holidays.subdivisions('DE', { lang: 'de' })).data).toEqual([{ code: 'DE-BY', name: 'Bayern' }, { code: 'DE-BY-X', name: 'DE-BY-X' }]);
    expect((await services.holidays.school('DE', 2026, 'DE-BY', { lang: 'de' })).data).toEqual([{ id: 's', start: '2026-08-03', end: '2026-09-14', name: 'Sommerferien', regions: ['DE-BY'] }]);
  });
});

describe('images', () => {
  const commons = { query: { pages: {
    1: { pageid: 1, title: 'File:Peak.jpg', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/peak.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Peak.jpg', extmetadata: { Artist: { value: '<a href="x">Ana</a>' }, LicenseShortName: { value: 'CC BY-SA 4.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' } } }] },
    2: { pageid: 2, title: 'File:NC.jpg', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/nc.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:NC.jpg', extmetadata: { Artist: { value: 'B' }, LicenseShortName: { value: 'CC BY-NC 2.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-nc/2.0' } } }] },
    3: { pageid: 3, title: 'File:Old.jpg', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/old.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Old.jpg', extmetadata: { LicenseShortName: { value: 'Public domain' } } }] },
  } } };
  it('searches Commons with per-image author and license credits after Openverse fails', async () => {
    const { services, urls } = fixture(url => url.includes('openverse') ? down() : commons, { providers: { images: ['unsplash', 'openverse', 'wikimedia'] } });
    const result = await services.images.search('mountain peak');
    expect(result.provider).toBe('wikimedia'); expect(result.data.map(photo => [photo.title, photo.author, photo.license])).toEqual([['Peak.jpg', 'Ana', 'CC BY-SA 4.0'], ['Old.jpg', '', 'Public domain']]);
    expect(new URL(urls()[1]).searchParams.get('gsrsearch')).toBe('mountain peak filetype:bitmap'); expect(urls().some(url => url.includes('unsplash'))).toBe(false);
    const named = structuredClone(commons); named.query.pages[1].imageinfo[0].extmetadata.Artist.value = 'O&#039;Brien &amp; <b>Co</b> &lt;x&gt;';
    const decoded = fixture(() => named, { providers: { images: ['wikimedia'] } }); expect((await decoded.services.images.search('mountain peak')).data[0].author).toBe("O'Brien & Co <x>");
    named.query.pages[1].imageinfo[0].extmetadata.Artist.value = 'Ana&#x202E;txt'; const bidi = fixture(() => named, { providers: { images: ['wikimedia'] } });
    expect((await bidi.services.images.search('mountain peak')).data[0].author).toBe('Ana txt');
  });
  it('uses the user Unsplash key first with referral credits and pings downloads on use', async () => {
    const unsplash = { results: [{ id: 'u1', alt_description: 'Lake', urls: { regular: 'https://images.unsplash.com/r', small: 'https://images.unsplash.com/s' }, links: { html: 'https://unsplash.com/photos/u1', download_location: 'https://api.unsplash.com/photos/u1/download' }, user: { name: 'Kim', links: { html: 'https://unsplash.com/@kim' } } }] };
    const { services, fetcher } = fixture(url => url.includes('/download') ? { url: 'x' } : unsplash, { providers: { images: ['unsplash', 'openverse'] }, keys: { unsplash: 'unsplash-key-1' } });
    const result = await services.images.search('lake');
    expect(result.data[0]).toMatchObject({ provider: 'unsplash', author: 'Kim', license: 'Unsplash License', downloadLocation: 'https://api.unsplash.com/photos/u1/download' });
    expect(result.data[0].source).toContain('utm_source=puter_trips'); expect(result.data[0].authorURL).toContain('utm_medium=referral');
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Client-ID unsplash-key-1');
    expect(await services.images.markUsed(result.data[0])).toBe(true); expect(String(fetcher.mock.calls[1][0])).toBe('https://api.unsplash.com/photos/u1/download');
    expect(await services.images.markUsed({ ...result.data[0], downloadLocation: 'https://evil.example/x' })).toBe(false); expect(await services.images.markUsed({ provider: 'openverse' })).toBe(false);
  });
});
