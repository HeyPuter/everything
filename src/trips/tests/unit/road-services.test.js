// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createServices } from '../../src/services/index.js';
import { createMemoryCache } from '../../src/services/core.js';
import { createRoadRoute } from '../../src/services/roadRoute.js';
import { createCorridor, categoryOf } from '../../src/services/corridor.js';
import { createHazards, dwdWarnings, gdacsEvents } from '../../src/services/hazards.js';

const worker = 'https://trips-geo.puter.work';
function fixture(respond, { providers = {}, geoWorker = worker, online = () => true } = {}) {
  const fetcher = vi.fn(async (url, init) => {
    const result = await respond(String(url), init);
    return result instanceof Response ? result : Response.json(result);
  });
  const services = createServices({ userId: 'alice', fetch: fetcher, cache: createMemoryCache(), keys: async () => null, config: { providers, disabled: [], geoWorker }, sleep: async () => {}, retries: 0, online });
  return { fetcher, services, urls: () => fetcher.mock.calls.map(([url]) => String(url)) };
}
// Encodes [lng, lat] pairs as a precision-6 polyline.
function encode(points) {
  let out = ''; let lat = 0; let lng = 0;
  const put = (value) => { let v = value < 0 ? ~(value << 1) : value << 1; while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } out += String.fromCharCode(v + 63); };
  for (const [x, y] of points) { const a = Math.round(y * 1e6); const b = Math.round(x * 1e6); put(a - lat); put(b - lng); lat = a; lng = b; }
  return out;
}
const down = () => new Response('', { status: 503 });

describe('road routing', () => {
  it('uses Valhalla first for per-leg shapes and toll and ferry flags', async () => {
    const trip = { status: 0, summary: { length: 30, time: 1800 }, legs: [
      { shape: encode([[1, 0], [1.1, 0]]), summary: { length: 11, time: 600, has_toll: true, has_ferry: false, has_highway: true } },
      { shape: encode([[1.1, 0], [1.3, 0]]), summary: { length: 19, time: 1200, has_ferry: true } },
    ] };
    const { services, fetcher } = fixture((url, init) => (url.endsWith('/valhalla') ? { trip, echo: JSON.parse(init.body) } : down()), { providers: { route: ['geo-osrm', 'geo-valhalla', 'straight'] } });
    const road = createRoadRoute({ context: services.context, route: services.route });
    const result = await road.route([[1, 0], [1.1, 0], [1.3, 0]], { avoid: ['motorway'] });
    expect(result.estimated).toBe(false);
    expect(result.legs.map((leg) => leg.flags)).toEqual([{ toll: true, ferry: false, motorway: true }, { toll: false, ferry: true, motorway: false }]);
    expect(result.legs[1]).toMatchObject({ distance: 19000, duration: 1200 });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ points: [[1, 0], [1.1, 0], [1.3, 0]], mode: 'drive', avoid: ['motorway'] });
  });

  it('falls back to the shared adapter and splits its line at the waypoints, without flags', async () => {
    const { services } = fixture(() => down(), { providers: { route: ['geo-osrm', 'geo-valhalla', 'straight'] } });
    const road = createRoadRoute({ context: services.context, route: services.route });
    const result = await road.route([[1, 0], [1.1, 0], [1.3, 0]]);
    expect(result.estimated).toBe(true);
    expect(result.legs).toHaveLength(2);
    expect(result.legs[0].line).toEqual([[1, 0], [1.1, 0]]);
    expect(result.legs.every((leg) => leg.flags === null)).toBe(true);
  });

  it('estimates offline without a cache and without a geo worker', async () => {
    const { services, fetcher } = fixture(() => down(), { geoWorker: null, online: () => false });
    const result = await createRoadRoute({ context: services.context, route: services.route }).route([[1, 0], [1.2, 0]]);
    expect(result.legs[0].distance).toBeGreaterThan(20_000);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('corridor search', () => {
  it('asks Photon once per box for every chosen category and keeps results near the route', async () => {
    const photon = { features: [
      { geometry: { type: 'Point', coordinates: [1.05, 0.01] }, properties: { osm_id: 1, osm_type: 'N', osm_key: 'amenity', osm_value: 'fuel', name: 'Fuel A' } },
      { geometry: { type: 'Point', coordinates: [1.05, 0.5] }, properties: { osm_id: 2, osm_type: 'N', osm_key: 'amenity', osm_value: 'fuel', name: 'Far' } },
      { geometry: { type: 'Point', coordinates: [1.02, -0.01] }, properties: { osm_id: 3, osm_type: 'W', osm_key: 'amenity', osm_value: 'charging_station' } },
      { geometry: { type: 'Point', coordinates: [1.03, 0] }, properties: { osm_id: 4, osm_type: 'N', osm_key: 'shop', osm_value: 'bakery', name: 'Bakery' } },
    ] };
    const { services, urls } = fixture(() => photon, { providers: { pois: ['photon'] } });
    const result = await createCorridor(services.context).search([[1, 0], [1.1, 0]], { categories: ['fuel', 'charging'], widthKm: 5 });
    expect(urls()).toHaveLength(1);
    expect(new URL(urls()[0]).searchParams.get('include')).toBe('osm.amenity.fuel,osm.amenity.charging_station');
    expect(result.results.map((item) => [item.id, item.category])).toEqual([['way:3', 'charging'], ['node:1', 'fuel']]);
    expect(result.attribution[0].text).toContain('Photon');
    expect(categoryOf('highway', 'services')).toBe('rest');
  });

  it('reports offline when nothing is cached', async () => {
    const { services } = fixture(() => down(), { online: () => false });
    const result = await createCorridor(services.context).search([[1, 0], [1.1, 0]], { categories: ['rest'] });
    expect(result).toMatchObject({ offline: true, results: [] });
  });
});

describe('hazards', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  it('reads current GDACS events and drops stale or malformed ones', () => {
    const events = gdacsEvents({ features: [
      { geometry: { type: 'Point', coordinates: [10, 45] }, properties: { eventtype: 'FL', eventid: 9, alertlevel: 'Orange', name: '<b>Flood</b> in X', todate: '2026-10-26T00:00:00', url: { report: 'https://www.gdacs.org/report.aspx?eventid=9' } } },
      { geometry: { type: 'Point', coordinates: [10, 45] }, properties: { eventtype: 'FL', eventid: 9, alertlevel: 'Orange' } },
      { geometry: { type: 'Point', coordinates: [10, 45] }, properties: { eventtype: 'EQ', eventid: 3, alertlevel: 'Red', todate: '2026-10-01T00:00:00' } },
      { geometry: { type: 'Point', coordinates: [10, 45] }, properties: { eventtype: 'XX', eventid: 4, alertlevel: 'Red' } },
    ] }, now);
    expect(events).toEqual([expect.objectContaining({ id: 'gdacs:FL:9', level: 'orange', name: 'Flood in X', point: [10, 45], url: 'https://www.gdacs.org/report.aspx?eventid=9' })]);
  });

  it('reads DWD warning areas and skips minor or expired ones', () => {
    const square = [[[8, 50], [9, 50], [9, 51], [8, 51], [8, 50]]];
    const warnings = dwdWarnings({ features: [
      { geometry: { type: 'Polygon', coordinates: square }, properties: { SEVERITY: 'Severe', EVENT: 'STURMBÖEN', HEADLINE: 'Amtliche Warnung', IDENTIFIER: 'a', EXPIRES: '2026-10-26T00:00:00Z' } },
      { geometry: { type: 'Polygon', coordinates: square }, properties: { SEVERITY: 'Minor', EVENT: 'FROST', IDENTIFIER: 'b' } },
      { geometry: { type: 'Polygon', coordinates: square }, properties: { SEVERITY: 'Extreme', EVENT: 'ORKAN', IDENTIFIER: 'c', EXPIRES: '2026-10-24T00:00:00Z' } },
    ] }, now);
    expect(warnings).toEqual([expect.objectContaining({ level: 'red', name: 'STURMBÖEN', bbox: [8, 50, 9, 51] })]);
  });

  it('asks DWD only where the route box overlaps Germany', async () => {
    const { services, urls } = fixture(() => ({ features: [] }), { providers: { hazards: ['gdacs', 'dwd'] } });
    const hazards = createHazards(services.context);
    expect((await hazards.dwd([-5, 40, 0, 42])).data).toEqual([]);
    expect(urls()).toEqual([]);
    await hazards.dwd([7, 49, 12, 52]);
    expect(new URL(urls()[0]).searchParams.get('typeNames')).toBe('dwd:Warnungen_Landkreise');
    await hazards.gdacs();
    expect(new URL(urls()[1]).searchParams.get('alertlevel')).toBe('orange;red');
  });
});
