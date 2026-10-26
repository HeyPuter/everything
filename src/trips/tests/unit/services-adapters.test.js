// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createServices } from '../../src/services/index.js';
import { createMemoryCache } from '../../src/services/core.js';
const fixture = (response, options = {}) => {
  const fetcher = vi.fn(async (url, init) => typeof response === 'function' ? response(String(url), init) : Response.json(response));
  return { fetcher, services: createServices({ userId: 'alice', fetch: fetcher, cache: createMemoryCache(), config: { providers: { geocode: ['photon'], route: ['geo-osrm', 'straight'], weather: ['metno'], normals: ['nasa'], fx: ['frankfurter', 'fawaz'], publicHolidays: ['nager'], schoolHolidays: ['openholidays'], images: ['openverse'], placeInfo: ['wikimedia'] }, disabled: [], geoWorker: null, nagerVersion: 3 }, sleep: async () => {}, retries: 0, ...options }) };
};
const photon = { features: [{ geometry: { type: 'Point', coordinates: [13.4, 52.5] }, properties: { osm_id: 1, osm_type: 'N', name: '<place>', countrycode: 'de' } }] };
describe('service adapters', () => {
  it('normalizes Photon and sends rounded bias while retaining text as text', async () => {
    const { services, fetcher } = fixture(photon); const result = await services.geocode.search('Berlin', { bias: { lat: 52.12345, lng: 13.98765 } });
    expect(result.data[0]).toMatchObject({ name: '<place>', lat: 52.5, lng: 13.4, country: 'DE' }); expect(result.attribution[0].license).toBe('ODbL'); const url = new URL(fetcher.mock.calls[0][0]); expect(url.searchParams.get('lat')).toBe('52.123');
    expect(await services.geocode.search('')).toBeNull(); await expect(async () => services.geocode.reverse(91, 0)).rejects.toThrow();
  });
  it('cancels superseded autocomplete and never sends it to Nominatim', async () => {
    const { services, fetcher } = fixture(photon, { config: { providers: { geocode: ['nominatim'] }, disabled: [], geoWorker: 'https://trips-geo.puter.work' } });
    const first = services.geocode.autocomplete('Berlin'); const second = services.geocode.autocomplete('Paris'); await expect(first).rejects.toMatchObject({ name: 'AbortError' }); expect(await second).toBeNull(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('filters invalid provider geometry and bounds POI scans', async () => {
    const { services } = fixture({ features: [...photon.features, { geometry: { coordinates: [0, 100] } }] }); expect((await services.geocode.search('Berlin')).data).toHaveLength(1);
    expect(() => services.geocode.pois([-180, -90, 180, 90], 'museum')).toThrow(); expect(() => services.geocode.pois([0, 0, 1, 1], 'unknown')).toThrow();
  });
  it('returns a labeled straight estimate without making a routing-provider request', async () => {
    const { services, fetcher } = fixture({}); const result = await services.route.route([[0, 0], [1, 0]], 'walk', { avoid: ['ferry'] }); expect(result.data).toMatchObject({ estimated: true, avoidsApplied: false }); expect(result.data.distance).toBeGreaterThan(130_000); expect(fetcher).not.toHaveBeenCalled();
    expect((await services.route.matrix([[0, 0], [1, 0]], 'drive')).data.durations[0][0]).toBe(0);
    expect(() => services.route.route([[0, 91], [0, 0]])).toThrow();
  });
  it('routes through the configured bridge and validates route data', async () => {
    const data = { routes: [{ distance: 20, duration: 30, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 0]] } }] };
    const { services, fetcher } = fixture(data, { config: { providers: { route: ['geo-osrm', 'straight'] }, geoWorker: 'https://trips-geo.puter.work', disabled: [] } });
    const routed = await services.route.route([[0, 0], [1, 0]]);
    expect(routed.data.estimated).toBe(false); expect(fetcher.mock.calls[0][0]).toBe('https://trips-geo.puter.work/route'); expect(fetcher.mock.calls[0][1].method).toBe('POST');
    expect(routed.attribution.at(-1)).toEqual({ text: 'Fix the map', url: 'https://www.openstreetmap.org/fixthemap' });
  });
  it('honors forecast Expires and rounds coordinates to four decimals', async () => {
    let now = 0; const payload = { properties: { timeseries: [{ time: '2026-10-24T12:00:00Z', data: { instant: { details: { air_temperature: 15, wind_speed: 2 } }, next_1_hours: { details: { precipitation_amount: 1 }, summary: { symbol_code: 'rain' } } } }] } };
    const { services, fetcher } = fixture(() => Response.json(payload, { headers: { Expires: new Date(1000).toUTCString() } }), { now: () => now });
    expect((await services.weather.forecast(52.123456, 13.123456)).data.entries[0]).toMatchObject({ temperatureC: 15, precipitationMm: 1 }); expect(new URL(fetcher.mock.calls[0][0]).searchParams.get('lat')).toBe('52.1235');
    await services.weather.forecast(52.123456, 13.123456); expect(fetcher).toHaveBeenCalledOnce(); now = 1001; await services.weather.forecast(52.123456, 13.123456); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('uses NASA half-degree cells and preserves missing climatology readings', async () => {
    const { services, fetcher } = fixture({ properties: { parameter: { T2M: { JAN: 10 }, T2M_MAX: { JAN: 12 }, T2M_MIN: { JAN: -999 }, PRECTOTCORR: { JAN: 2 } } } });
    expect((await services.weather.normals(20.12, 30.26, 1)).data).toMatchObject({ lat: 20, lng: 30.5, temperatureC: 10, lowC: null, precipitationMmDay: 2 }); expect(new URL(fetcher.mock.calls[0][0]).searchParams.get('community')).toBe('RE');
  });
  it('parses Frankfurter v2 and rejects malformed FX/date input', async () => {
    const { services } = fixture([{ base: 'USD', quote: 'EUR', rate: 0.9, date: '2026-10-23' }]); expect((await services.fx.rates('USD')).data).toEqual({ base: 'USD', date: '2026-10-23', rates: { USD: 1, EUR: 0.9 } });
    expect(() => services.fx.rates('usd')).toThrow(); expect(() => services.fx.rates('USD', '2026-02-30')).toThrow();
  });
  it('falls back to CC0 FX and filters non-currency quotes', async () => {
    const { services, fetcher } = fixture(url => url.includes('frankfurter') ? new Response('', { status: 503 }) : Response.json({ date: '2026-10-23', usd: { eur: 0.9, btc: 0.0001, invalid: 3, bad: -1 } }));
    const result = await services.fx.rates('USD'); expect(result.provider).toBe('fawaz'); expect(result.data.rates).not.toHaveProperty('INVALID'); expect(result.data.rates).not.toHaveProperty('BTC'); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('filters holiday subdivisions and normalizes school date ranges', async () => {
    const { services } = fixture(url => Response.json(url.includes('SchoolHolidays') ? [{ id: 'a', startDate: '2026-07-01', endDate: '2026-08-01', name: [{ language: 'EN', text: 'Summer' }] }] : [{ date: '2026-01-01', name: 'New Year', global: true }, { date: '2026-02-01', name: 'Other region', counties: ['DE-BE'] }]));
    expect((await services.holidays.public('DE', 2026, 'DE-BY')).data).toHaveLength(1); expect((await services.holidays.school('DE', 2026, 'DE-BY')).data[0].name).toBe('Summer');
  });
  it('returns only images with safe URLs and usable commercial credits', async () => {
    const row = { id: 'a', url: 'https://img.example/a', thumbnail: 'https://img.example/t', foreign_landing_url: 'https://example.com/a', creator: 'Author', license: 'by', license_url: 'https://creativecommons.org/licenses/by/4.0/' };
    const { services, fetcher } = fixture({ results: [row, { ...row, license: 'by-nc' }, { ...row, url: 'javascript:alert(1)' }] }); const result = await services.images.search('mountains'); expect(result.data).toHaveLength(1); expect(result.data[0].author).toBe('Author'); expect(new URL(fetcher.mock.calls[0][0]).searchParams.get('license_type')).toBe('commercial');
  });
  it('loads only validated offline airport rows and looks up case-insensitive codes', async () => {
    const { services } = fixture({ airports: [{ iata: 'YVR', name: 'Vancouver', city: 'Vancouver', country: 'CA', lat: 49.2, lng: -123.2, tz: 'America/Vancouver' }, { iata: 'BAD', name: 'Bad', lat: 91, lng: 0, tz: 'Bad/Zone' }] });
    expect((await services.airports.byCode('yvr')).tz).toBe('America/Vancouver'); expect(await services.airports.search('van')).toHaveLength(1); expect(await services.airports.byCode('BAD')).toBeNull();
  });
  it('resolves offline timezone with the installed CC0 lookup', async () => {
    const { services, fetcher } = fixture({}); expect(await services.tz.zoneAt(49.2, -123.2)).toBe('America/Vancouver'); expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps Wikimedia description attribution and strips HTML from author metadata', async () => {
    const { services } = fixture(url => Response.json(url.includes('wbgetentities') ? { entities: { Q1: { id: 'Q1', descriptions: { en: { value: 'Short' } }, sitelinks: { enwiki: { title: 'Place' } } } } } : url.includes('wbgetclaims') ? { claims: { P18: [{ mainsnak: { datavalue: { value: 'Place.jpg' } } }] } } : url.includes('page/summary') ? { extract: 'A place.' } : { query: { pages: { 1: { imageinfo: [{ thumburl: 'https://upload.wikimedia.org/a.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:A', extmetadata: { Artist: { value: '<a>Author</a>' }, LicenseShortName: { value: 'CC BY' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by/4.0/' } } }] } } } }));
    const result = await services.placeInfo.details({ wikidata: 'Q1' }); expect(result.data.description).toBe('A place.'); expect(result.data.photos[0].author).toBe('Author'); expect(result.attribution.some(x => x.license === 'CC BY-SA 4.0')).toBe(true);
  });
});
