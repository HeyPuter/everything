// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createServices, openingStatus, parseOpeningHours, planDay, routeDay } from '../../src/services/index.js';
import { createMemoryCache } from '../../src/services/core.js';
import { osmFacts } from '../../src/services/placeInfo.js';

const worker = 'https://trips-geo.puter.work';
function fixture(respond, { geoWorker = worker, ...options } = {}) {
  const fetcher = vi.fn(async (url, init) => { const result = await respond(String(url), init); return result instanceof Response ? result : Response.json(result); });
  const services = createServices({ userId: 'alice', fetch: fetcher, cache: createMemoryCache(), config: { providers: { placeInfo: ['wikimedia'], route: ['geo-osrm', 'straight'] }, disabled: [], geoWorker }, sleep: async () => {}, retries: 0, ...options });
  return { services, fetcher, urls: () => fetcher.mock.calls.map(([url]) => String(url)) };
}
const entity = { id: 'Q82425', labels: { de: { value: 'Brandenburger Tor' }, en: { value: 'Brandenburg Gate' } }, descriptions: { en: { value: 'Gate in Berlin' } }, sitelinks: { dewiki: { title: 'Brandenburger Tor' }, enwikivoyage: { title: 'Berlin/Mitte' } } };
const commons = { query: { pages: { 1: { pageid: 1, title: 'File:Gate.jpg', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/gate.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Gate.jpg', extmetadata: { Artist: { value: '<span>Thomas</span>' }, LicenseShortName: { value: 'CC BY-SA 3.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/3.0' } } }] } } } };
const lookup = [{ name: 'Brandenburger Tor', extratags: { wikidata: 'Q82425', opening_hours: 'Mo-Fr 09:00-18:00; Sa 10:00-14:00', wheelchair: 'yes', website: 'https://example.org/tor', 'contact:phone': '+49 30 1234', fee: 'no', cuisine: 'german;<script>', password: 'x' } }];
const responder = url => {
  if (url.startsWith(worker + '/nominatim/lookup')) return lookup;
  if (url.startsWith('https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q82425&')) return { entities: { Q82425: entity } };
  if (url.startsWith('https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=Q82425&property=P18')) return { claims: { P18: [{ mainsnak: { datavalue: { value: 'Gate.jpg' } } }] } };
  // Summary titles must use underscores; the REST API redirects other spellings.
  if (url === 'https://en.wikivoyage.org/api/rest_v1/page/summary/Berlin%2FMitte') return { extract: 'Voyage text' };
  if (url === 'https://de.wikipedia.org/api/rest_v1/page/summary/Brandenburger_Tor') return { extract: '<b>Wiki</b> text' };
  if (url.includes('commons.wikimedia.org')) return commons;
  return new Response('', { status: 404 });
};

describe('place details', () => {
  it('reads OSM tags through the geo worker and orders Wikivoyage before Wikipedia in the user language', async () => {
    const { services, urls } = fixture(responder, { now: () => Date.parse('2026-10-23T10:00:00Z') });
    const result = await services.placeInfo.details({ osm: { type: 'node', id: 123 }, lang: 'de', tz: 'Europe/Berlin' });
    expect(urls()[0]).toBe(`${worker}/nominatim/lookup?osm_ids=N123&lang=de`);
    expect(result.data).toMatchObject({ wikidata: 'Q82425', name: 'Brandenburger Tor', description: 'Voyage text', descriptionSource: 'wikivoyage', timeZone: 'Europe/Berlin' });
    expect(result.data.summaries).toEqual([
      { source: 'wikivoyage', lang: 'en', text: 'Voyage text', url: 'https://en.wikivoyage.org/wiki/Berlin%2FMitte' },
      { source: 'wikipedia', lang: 'de', text: 'Wiki text', url: 'https://de.wikipedia.org/wiki/Brandenburger_Tor' },
    ]);
    expect(result.data.photos).toEqual([expect.objectContaining({ author: 'Thomas', license: 'CC BY-SA 3.0', provider: 'wikimedia' })]);
    expect(result.data.hours).toMatchObject({ raw: 'Mo-Fr 09:00-18:00; Sa 10:00-14:00', week: { mo: ['09:00-18:00'], sa: ['10:00-14:00'], su: [] }, open: true });
    expect(result.data.facts).toEqual([{ key: 'cuisine', value: ['german'] }, { key: 'wheelchair', value: 'yes' }, { key: 'fee', value: 'no' }, { key: 'website', value: 'https://example.org/tor' }, { key: 'phone', value: '+49 30 1234' }]);
    const licenses = result.attribution.map(credit => [credit.text, credit.license]);
    expect(licenses).toEqual(expect.arrayContaining([['Wikidata', 'CC0'], ['Wikivoyage contributors', 'CC BY-SA 4.0'], ['Wikipedia contributors', 'CC BY-SA 4.0'], ['© OpenStreetMap contributors', 'ODbL']]));
  });
  it('computes open or closed at read time in the place time zone, not from the cache', async () => {
    let now = Date.parse('2026-10-23T10:00:00Z');
    const { services, fetcher } = fixture(responder, { now: () => now });
    const input = { wikidata: 'Q82425', tags: { opening_hours: 'Mo-Fr 09:00-18:00' }, lat: 52.5163, lng: 13.3777 };
    expect((await services.placeInfo.details(input)).data.hours.open).toBe(true);
    const calls = fetcher.mock.calls.length; now = Date.parse('2026-10-23T17:30:00Z');
    const later = await services.placeInfo.details(input); expect(later.data.hours.open).toBe(false); expect(later.data.timeZone).toBe('Europe/Berlin'); expect(fetcher).toHaveBeenCalledTimes(calls);
  });
  it('prefers the OSM description, falls back to Openverse photos by name and skips lookups without a geo worker', async () => {
    const respond = url => url.includes('openverse') ? { results: [{ id: 'o', url: 'https://img.example/a', foreign_landing_url: 'https://example.com/a', license: 'by', license_url: 'https://creativecommons.org/licenses/by/4.0/', creator: 'Ola' }] } : new Response('', { status: 404 });
    const { services, urls } = fixture(respond, { geoWorker: null });
    const result = await services.placeInfo.details({ osm: 'W42', tags: { description: 'Small chapel', name: 'Kapelle' } });
    expect(result.data).toMatchObject({ description: 'Small chapel', descriptionSource: 'osm', wikidata: null, photos: [{ provider: 'openverse', author: 'Ola' }] });
    expect(urls().some(url => url.includes('nominatim'))).toBe(false); expect(new URL(urls()[0]).searchParams.get('q')).toBe('Kapelle');
    expect(await fixture(respond, { geoWorker: null }).services.placeInfo.details({ osm: 'N1' })).toBeNull();
  });
  it('keeps OSM hours and facts when Wikidata fails, caching that partial answer for an hour', async () => {
    let now = Date.parse('2026-10-23T10:00:00Z'); let wikidataUp = false;
    const { services, fetcher } = fixture(url => url.includes('wikidata.org') && !wikidataUp ? new Response('', { status: 503 }) : responder(url), { now: () => now });
    const input = { wikidata: 'Q82425', tags: { opening_hours: 'Mo-Fr 09:00-18:00', wheelchair: 'yes' }, tz: 'Europe/Berlin', lang: 'DE' };
    const partial = await services.placeInfo.details(input);
    expect(partial.data).toMatchObject({ wikidata: 'Q82425', summaries: [], hours: { open: true }, facts: [{ key: 'wheelchair', value: 'yes' }] });
    wikidataUp = true; await services.placeInfo.details(input); const calls = fetcher.mock.calls.length;
    now += 3_600_001; expect((await services.placeInfo.details(input)).data.description).toBe('Voyage text'); expect(fetcher.mock.calls.length).toBeGreaterThan(calls);
    await expect(fixture(() => new Response('', { status: 503 })).services.placeInfo.details({ wikidata: 'Q1' })).resolves.toBeNull();
  });
  it('looks up OSM tags again once a geo worker is configured', async () => {
    let geoWorker = null;
    const fetcher = vi.fn(async url => Response.json(responder(String(url)) instanceof Response ? {} : responder(String(url))));
    const services = createServices({ userId: 'alice', fetch: fetcher, cache: createMemoryCache(), config: () => ({ providers: { placeInfo: ['wikimedia'] }, disabled: [], geoWorker }), retries: 0, sleep: async () => {} });
    const before = await services.placeInfo.details({ wikidata: 'Q82425', osm: 'N123' }); expect(before.data.hours).toBeNull();
    geoWorker = worker; const after = await services.placeInfo.details({ wikidata: 'Q82425', osm: 'N123' });
    expect(after.data.hours.week.mo).toEqual(['09:00-18:00']); expect(fetcher.mock.calls.some(([url]) => String(url).includes('/nominatim/lookup'))).toBe(true);
  });
  it('validates identifiers synchronously and returns null without any reference', async () => {
    const { services } = fixture(responder);
    expect(await services.placeInfo.details({ lat: 1, lng: 2 })).toBeNull();
    expect(() => services.placeInfo.details({ wikidata: 'P1' })).toThrow(); expect(() => services.placeInfo.details({ osm: 'X1' })).toThrow(); expect(() => services.placeInfo.details({ wikidata: 'Q1', lang: 'EN!' })).toThrow();
  });
  it('normalizes OSM facts to known keys and enums', () => {
    expect(osmFacts({ wheelchair: 'maybe', stars: '4S', ele: '1234.6', website: 'javascript:alert(1)', 'diet:vegan': 'only', phone: 'call me' })).toEqual([{ key: 'vegan', value: 'only' }, { key: 'stars', value: 4 }, { key: 'elevation', value: 1235 }]);
  });
});

describe('opening hours', () => {
  it('parses supported OSM syntax into a weekly table and keeps the rest as raw text', async () => {
    expect((await parseOpeningHours('Mo - Fr 08:00-12:00, 13:00-17:30; Sa 09:00-13:00; PH off')).week).toEqual({ su: [], mo: ['08:00-12:00', '13:00-17:30'], tu: ['08:00-12:00', '13:00-17:30'], we: ['08:00-12:00', '13:00-17:30'], th: ['08:00-12:00', '13:00-17:30'], fr: ['08:00-12:00', '13:00-17:30'], sa: ['09:00-13:00'] });
    expect((await parseOpeningHours('24/7')).week.su).toEqual(['00:00-24:00']);
    expect((await parseOpeningHours('10:00-22:00')).week.we).toEqual(['10:00-22:00']);
    expect((await parseOpeningHours('Mo-Su 10:00-20:00; Tu closed')).week.tu).toEqual([]);
    expect((await parseOpeningHours('Fr-Mo 18:00-02:00')).week).toMatchObject({ fr: ['18:00-02:00'], sa: ['18:00-02:00'], su: ['18:00-02:00'], mo: ['18:00-02:00'], tu: [] });
    for (const raw of ['Jan-Mar Mo 10:00-12:00', 'sunrise-sunset', 'Mo 25:00-26:00', 'Mo-Fr 10:00+', '"by appointment"']) expect(await parseOpeningHours(raw)).toEqual({ raw, week: null, holidays: null });
    expect(await parseOpeningHours('')).toBeNull(); expect((await parseOpeningHours('Mo-Fr 09:00-17:00; PH 10:00-12:00')).holidays).toEqual(['10:00-12:00']);
  });
  it('evaluates overnight ranges in the place time zone', async () => {
    const hours = await parseOpeningHours('Fr 18:00-02:00');
    const at = iso => openingStatus(hours, { timeZone: 'America/New_York', now: Date.parse(iso) }).open;
    expect(at('2026-10-23T22:30:00Z')).toBe(true); expect(at('2026-10-24T05:30:00Z')).toBe(true); expect(at('2026-10-24T06:30:00Z')).toBe(false); expect(at('2026-10-23T21:00:00Z')).toBe(false);
    expect(openingStatus(hours, { timeZone: 'Not/AZone' }).open).toBeNull(); expect(openingStatus({ raw: 'x', week: null }, { timeZone: 'UTC' }).open).toBeNull();
  });
});

describe('day routes', () => {
  const stay = { id: 'hotel', lat: 48.85, lng: 2.35 };
  it('starts and ends at the stay, resets at bookings and splits on leg mode changes', () => {
    const plan = planDay({ start: stay, end: { id: 'hotel2', lat: 45.76, lng: 4.83 }, mode: 'walk', stops: [
      { id: 'a', lat: 48.86, lng: 2.34 }, { id: 'b', lat: 48.87, lng: 2.33, mode: 'bike' }, { id: 'c', lat: 48.88, lng: 2.32, mode: 'bike' },
      { id: 'train', transport: { type: 'train', status: 'pending', from: { lat: 48.84, lng: 2.37 }, to: { lat: 45.76, lng: 4.86 } } },
      { id: 'noloc' }, { id: 'd', lat: 45.77, lng: 4.84 },
    ] });
    expect(plan.segments.map(segment => [segment.kind, segment.mode ?? segment.type, segment.ids ?? segment.id])).toEqual([
      ['road', 'walk', ['hotel', 'a']], ['road', 'bike', ['a', 'b', 'c', 'train']], ['transport', 'train', 'train'], ['road', 'walk', ['train', 'd', 'hotel2']],
    ]);
    expect(plan.segments[2]).toMatchObject({ status: 'pending', from: [2.37, 48.84], to: [4.86, 45.76] });
    expect(planDay({ stops: [{ id: 'x', lat: 1, lng: 1 }, { id: 'y', lat: 1, lng: 1 }] }).segments).toEqual([]);
    const airport = planDay({ start: stay, mode: 'drive', stops: [{ id: 'f', transport: { type: 'flight', from: { lat: 49, lng: 2.55 }, to: { lat: 40.6, lng: -73.8 } } }, { id: 'x', lat: 40.7, lng: -74, mode: 'walk' }] });
    expect(airport.segments[0]).toMatchObject({ kind: 'road', mode: 'drive', ids: ['hotel', 'f'] });
    expect(() => planDay({ mode: 'plane' })).toThrow(); expect(() => planDay({ stops: [{ id: 'x', lat: 91, lng: 0 }] })).toThrow();
  });
  it('routes road chunks, draws arcs for flights, routes car bookings and reports totals', async () => {
    const osrm = (_url, init) => {
      const { points } = JSON.parse(init.body); const legs = points.slice(1).map(() => ({ distance: 500, duration: 300 }));
      return { code: 'Ok', routes: [{ distance: legs.length * 500, duration: legs.length * 300, geometry: { type: 'LineString', coordinates: points }, legs }] };
    };
    const { services } = fixture(osrm);
    const result = await services.route.day({ start: stay, mode: 'walk', stops: [
      { id: 'a', lat: 48.86, lng: 2.34 },
      { id: 'flight', transport: { type: 'flight', status: 'confirmed', from: { lat: 49.0, lng: 2.55 }, to: { lat: 40.64, lng: -73.78 } } },
      { id: 'car', transport: { type: 'car', from: { lat: 40.64, lng: -73.78 }, to: { lat: 40.75, lng: -73.99 } } },
    ] });
    expect(result.legs).toEqual([{ from: 'hotel', to: 'a', mode: 'walk', distance: 500, duration: 300, estimated: false }, { from: 'a', to: 'flight', mode: 'walk', distance: 500, duration: 300, estimated: false }]);
    expect(result.features.features.map(feature => [feature.properties.kind, feature.properties.type ?? feature.properties.mode, feature.geometry.type])).toEqual([
      ['road', 'walk', 'LineString'], ['transport', 'flight', 'LineString'], ['transport', 'car', 'LineString'],
    ]);
    expect(result.transports.find(item => item.id === 'car')).toMatchObject({ distance: 500, estimated: false });
    expect(result.distance).toBe(1000); expect(result.estimated).toBe(false); expect(result.attribution.some(credit => credit.text.includes('FOSSGIS'))).toBe(true);
  });
  it('splits long chunks to the 25 point provider limit and falls back to local estimates offline', async () => {
    const stops = Array.from({ length: 30 }, (_, i) => ({ id: 's' + i, lat: 48 + i / 100, lng: 2 }));
    const route = { route: vi.fn(async () => null) };
    const result = await routeDay(route, planDay({ stops, mode: 'drive' }));
    expect(route.route.mock.calls.map(([points]) => points.length)).toEqual([25, 6]); expect(result.legs).toHaveLength(29);
    expect(result.legs[24]).toMatchObject({ from: 's24', to: 's25', estimated: true }); expect(result.estimated).toBe(true); expect(result.features.features).toHaveLength(2);
    const controller = new AbortController(); controller.abort();
    await expect(routeDay(route, planDay({ stops, mode: 'drive' }), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
