// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createGeoHandler, createKvLimiter } from '../../worker-geo/handler.js';
import { normalizeRequest } from '../../worker-geo/normalize.js';
import { cacheKey, createGeoCache, createLru } from '../../worker-geo/cache.js';
import { CONFIG_KEY, createRemoteConfig, sanitizeRemoteConfig } from '../../worker-geo/remote.js';

const base = 'https://trips-geo.puter.work';
function memoryKv() {
  const store = new Map();
  return {
    store,
    get: vi.fn(async key => structuredClone(store.get(key) ?? null)),
    set: vi.fn(async (key, value) => { store.set(key, structuredClone(value)); return true; }),
    incr: vi.fn(async key => { const n = (store.get(key) ?? 0) + 1; store.set(key, n); return n; }),
    expire: vi.fn(async () => true),
  };
}
const remote = (value = {}) => async () => sanitizeRemoteConfig({ regions: 1, ...value });
function fixture(options = {}) {
  const kv = memoryKv();
  const fetcher = vi.fn(async () => Response.json([{ lat: '52', lon: '13', display_name: 'Berlin' }]));
  const limiter = vi.fn(async () => ({ ok: true }));
  const handle = createGeoHandler({ kv, fetch: fetcher, limiter, remoteConfig: remote(), enabled: ['nominatim', 'osrm', 'valhalla'], ...options });
  return { kv, fetcher, limiter, handle };
}
const post = (path, body, headers = {}) => new Request(base + path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers });

describe('geo worker normalization', () => {
  const search = query => normalizeRequest({ method: 'GET', pathname: '/nominatim/search', params: new URLSearchParams(query) });
  it('folds case and whitespace into one search identity and rounds the viewbox', () => {
    const a = search('q=  New   York &lang=EN&viewbox=-74.0123,40.7012,-73.9,40.81');
    const b = search('q=new york&lang=en&viewbox=-74.01,40.70,-73.90,40.81');
    expect(a.key).toEqual(b.key); expect(a.key).toEqual({ kind: 'search', q: 'new york', lang: 'en', viewbox: [-74.01, 40.7, -73.9, 40.81] });
    const upstream = new URL(a.upstream.url);
    expect(upstream.hostname).toBe('nominatim.openstreetmap.org'); expect(upstream.searchParams.get('viewbox')).toBe('-74.01,40.7,-73.9,40.81');
    expect(upstream.searchParams.get('accept-language')).toBe('en'); expect(upstream.searchParams.get('extratags')).toBe('1');
    expect(search('q=x&lang=de').key).not.toEqual(search('q=x&lang=en').key);
  });
  it('rounds reverse lookups to five decimals and accepts one OSM id for lookups', () => {
    const reverse = normalizeRequest({ method: 'GET', pathname: '/nominatim/reverse', params: new URLSearchParams('lat=52.1234567&lon=13.7654321') });
    expect(reverse.key).toEqual({ kind: 'reverse', lat: '52.12346', lng: '13.76543', lang: 'en' });
    const lookup = normalizeRequest({ method: 'GET', pathname: '/nominatim/lookup', params: new URLSearchParams('osm_ids=N123') });
    expect(new URL(lookup.upstream.url).pathname).toBe('/lookup'); expect(lookup.key.ids).toBe('N123');
    for (const query of ['osm_ids=N1,W2', 'osm_ids=X1', 'osm_ids=N1&url=x']) expect(() => normalizeRequest({ method: 'GET', pathname: '/nominatim/lookup', params: new URLSearchParams(query) })).toThrow();
    expect([[], { error: 'x' }, { lat: '1' }].map(search('q=a').accept)).toEqual([true, true, false]); expect([{ lat: '1' }, { error: 'x' }, []].map(reverse.accept)).toEqual([true, true, false]);
    expect(() => search('q=a&q=b')).toThrow(); expect(() => search('q=a&viewbox=1,2,3')).toThrow(); expect(() => search('q=a&lang=<x>')).toThrow();
  });
  it('rounds waypoints, keeps the profile and maps modes to FOSSGIS profiles', () => {
    const route = normalizeRequest({ method: 'POST', pathname: '/route', body: { points: [[13.1234567, 52.1234567], [13.2, 52.2]], mode: 'bike' } });
    expect(route.key).toEqual({ kind: 'route', points: [[13.12346, 52.12346], [13.2, 52.2]], mode: 'bike' });
    expect(route.upstream.url).toContain('/routed-bike/route/v1/driving/13.12346,52.12346;13.2,52.2'); expect(new URL(route.upstream.url).searchParams.get('geometries')).toBe('polyline6');
    const table = normalizeRequest({ method: 'POST', pathname: '/matrix', body: { points: [[0, 0], [1, 1]], mode: 'drive' } });
    expect(table.upstream.url).toContain('/routed-car/table/v1/driving/'); expect(new URL(table.upstream.url).searchParams.get('annotations')).toBe('duration,distance');
    expect(() => normalizeRequest({ method: 'POST', pathname: '/matrix', body: { points: Array(11).fill([0, 0]), mode: 'drive' } })).toThrow();
    expect(() => normalizeRequest({ method: 'POST', pathname: '/route', body: { points: [[0, 0], [1, 1]], mode: 'drive', extra: 1 } })).toThrow();
  });
  it('builds Valhalla avoid options with sorted, deduplicated cache identity', () => {
    const a = normalizeRequest({ method: 'POST', pathname: '/valhalla', body: { points: [[0, 0], [1, 1]], mode: 'drive', avoid: ['toll', 'ferry', 'toll'] } });
    const b = normalizeRequest({ method: 'POST', pathname: '/valhalla', body: { points: [[0, 0], [1, 1]], mode: 'drive', avoid: ['ferry', 'toll'] } });
    expect(a.key).toEqual(b.key); expect(a.upstream.method).toBe('POST'); expect(a.upstream.url).toBe('https://valhalla1.openstreetmap.de/route');
    expect(JSON.parse(a.upstream.body)).toMatchObject({ costing: 'auto', costing_options: { auto: { use_tolls: 0, use_ferry: 0 } }, locations: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }] });
    const walk = normalizeRequest({ method: 'POST', pathname: '/valhalla', body: { points: [[0, 0], [1, 1]], mode: 'walk', avoid: ['toll', 'ferry'] } });
    expect(JSON.parse(walk.upstream.body).costing_options).toEqual({ pedestrian: { use_ferry: 0 } });
    expect(() => normalizeRequest({ method: 'POST', pathname: '/valhalla', body: { points: [[0, 0], [1, 1]], mode: 'drive', avoid: ['tolls'] } })).toThrow();
    expect(normalizeRequest({ method: 'GET', pathname: '/other' })).toBeNull();
  });
});

describe('geo worker cache', () => {
  it('evicts the least recently used isolate entry', () => {
    const lru = createLru(2); lru.set('a', 1); lru.set('b', 2); lru.get('a'); lru.set('c', 3);
    expect(lru.get('b')).toBeUndefined(); expect(lru.get('a')).toBe(1); expect(lru.size).toBe(2);
  });
  it('serves memory before KV, honours expiry and stores KV entries with an absolute expiry', async () => {
    let now = 1_000_000; const kv = memoryKv(); const cache = createGeoCache({ kv, now: () => now });
    const key = await cacheKey('osrm', { a: 1 }); expect(key).toMatch(/^geo:osrm:[0-9a-f]{64}$/); expect(await cacheKey('osrm', { a: 1 })).toBe(key);
    await cache.set(key, { ok: true }, 10); expect(kv.set).toHaveBeenCalledWith(key, { data: { ok: true }, expires: 1_010_000 }, 1010);
    expect(await cache.get(key)).toEqual({ data: { ok: true }, layer: 'memory' }); expect(kv.get).not.toHaveBeenCalled();
    const cold = createGeoCache({ kv, now: () => now }); expect(await cold.get(key)).toEqual({ data: { ok: true }, layer: 'kv' }); expect(await cold.get(key)).toMatchObject({ layer: 'memory' });
    now += 10_001; expect(await cache.get(key)).toBeNull(); expect(await cold.get(key)).toBeNull();
  });
  it('refuses oversized values and treats KV failures as misses', async () => {
    const kv = memoryKv(); const cache = createGeoCache({ kv, maxBytes: 100 });
    expect(await cache.set('k', 'x'.repeat(200), 10)).toBe(false); expect(kv.set).not.toHaveBeenCalled();
    kv.get.mockRejectedValueOnce(new Error('rate limited')); expect(await cache.get('other')).toBeNull();
    kv.set.mockRejectedValueOnce(new Error('rate limited')); expect(await cache.set('small', 1, 10)).toBe(false); expect(await cache.get('small')).toMatchObject({ layer: 'memory' });
  });
});

describe('geo worker limiter', () => {
  it('uses the window key with a five second expiry and waits up to one second for the next window', async () => {
    let now = 5_400; const kv = memoryKv(); const sleep = vi.fn(async ms => { now += ms; });
    const limit = createKvLimiter(kv, { now: () => now, sleep, random: () => 'x' });
    expect(await limit('nominatim', { regions: 1 })).toEqual({ ok: true });
    expect(kv.incr).toHaveBeenCalledWith('rl:nominatim:5'); expect(kv.expire).toHaveBeenCalledWith('rl:nominatim:5', 5);
    expect(await limit('nominatim', { regions: 1 })).toEqual({ ok: true }); expect(sleep).toHaveBeenCalledWith(600); expect(kv.store.get('rl:nominatim:6')).toBe(1);
    expect(kv.incr.mock.calls.filter(([key]) => key.startsWith('rl:probe:'))).toHaveLength(2);
  });
  it('answers retry hints when the next window is also full', async () => {
    let now = 9_000; const kv = memoryKv(); kv.store.set('rl:osrm:9', 1); kv.store.set('rl:osrm:10', 1);
    const limit = createKvLimiter(kv, { now: () => now, sleep: async ms => { now += ms; } });
    expect(await limit('osrm', { regions: 1 })).toEqual({ ok: false, retryAfter: 1 });
  });
  it('splits the global budget across declared regions', async () => {
    let now = 10_000; const kv = memoryKv(); const sleep = vi.fn(async ms => { now += ms; });
    const limit = createKvLimiter(kv, { now: () => now, sleep });
    expect(await limit('osrm', { regions: 2 })).toEqual({ ok: true }); expect(kv.incr).toHaveBeenLastCalledWith('rl:osrm:10'); expect(kv.expire).toHaveBeenLastCalledWith('rl:osrm:10', 6);
    expect(await limit('osrm', { regions: 2 })).toEqual({ ok: false, retryAfter: 2 }); expect(sleep).not.toHaveBeenCalled();
    expect(await createKvLimiter(memoryKv(), { now: () => 0 })('osrm', { regions: 1, limit: 2 })).toEqual({ ok: true });
  });
  it('stays unverified without a region declaration or with a non-atomic counter', async () => {
    const kv = memoryKv();
    for (const regions of [undefined, null, 0, 17, 1.5]) await expect(createKvLimiter(kv)('osrm', { regions })).rejects.toMatchObject({ code: 'global_limiter_unverified', status: 503 });
    expect(kv.incr).not.toHaveBeenCalled();
    const broken = { ...memoryKv(), incr: vi.fn(async () => 1) };
    await expect(createKvLimiter(broken)('osrm', { regions: 1 })).rejects.toMatchObject({ status: 503 });
  });
  it('allows at most one upstream call per window under concurrency', async () => {
    const kv = memoryKv(); const limit = createKvLimiter(kv, { now: () => 3_000, sleep: async () => {}, maxWait: 0 });
    const results = await Promise.all(Array.from({ length: 8 }, () => limit('nominatim', { regions: 1 })));
    expect(results.filter(result => result.ok)).toHaveLength(1);
  });
});

describe('geo worker remote config', () => {
  it('sanitizes the kill switch and caches it for the TTL', async () => {
    expect(sanitizeRemoteConfig({ regions: 99, disabled: ['osrm', 'evil'], killed: 'yes', limits: { osrm: 50, nominatim: 0.5 } })).toEqual({ regions: null, disabled: ['osrm'], killed: false, limits: { nominatim: 0.5, osrm: 1, valhalla: 1 } });
    let now = 0; const kv = memoryKv(); kv.store.set(CONFIG_KEY, { regions: 1, killed: true }); const read = createRemoteConfig({ kv, now: () => now, ttl: 1000 });
    expect((await read()).killed).toBe(true); kv.store.set(CONFIG_KEY, { regions: 1 }); expect((await read()).killed).toBe(true); expect(kv.get).toHaveBeenCalledOnce();
    now = 1001; expect((await read()).killed).toBe(false);
    kv.get.mockRejectedValueOnce(new Error('down')); now = 3000; expect((await read()).regions).toBe(1);
  });
});

describe('geo worker handler', () => {
  it('allows only fixed provider routes, permitted origins and unauthenticated requests', async () => {
    const { handle, fetcher } = fixture(); expect((await handle(new Request(base + '/other'))).status).toBe(404);
    expect((await handle(new Request(base + '/nominatim/search?q=Berlin', { headers: { Origin: 'https://evil.example' } }))).status).toBe(403);
    expect((await handle(new Request(base + '/nominatim/search?q=Berlin', { headers: { 'puter-auth': 'secret' } }))).status).toBe(400);
    expect((await handle(new Request(base + '/nominatim/search?q=Berlin&url=https://evil.example'))).status).toBe(400); expect(fetcher).not.toHaveBeenCalled();
  });
  it('identifies upstream calls and caches normalized successful searches', async () => {
    const { handle, kv, fetcher } = fixture(); const result = await handle(new Request(base + '/nominatim/search?q=Berlin&lang=en', { headers: { Origin: 'https://trips.puter.com' } }));
    expect(result.status).toBe(200); expect(result.headers.get('access-control-allow-origin')).toBe('https://trips.puter.com'); expect(result.headers.get('x-cache')).toBe('miss');
    expect(fetcher.mock.calls[0][1].headers['User-Agent']).toBe('PuterTrips/1.0 (+https://trips.puter.com)'); expect(String(fetcher.mock.calls[0][0])).toContain('nominatim.openstreetmap.org/search');
    const again = await handle(new Request(base + '/nominatim/search?q=BERLIN&lang=en')); expect(again.headers.get('x-cache')).toBe('memory');
    expect(fetcher).toHaveBeenCalledOnce(); expect(kv.set).toHaveBeenCalledOnce();
  });
  it('refuses missing/out-of-range coordinates and oversized route bodies', async () => {
    const { handle, fetcher } = fixture();
    for (const query of ['lat=91&lon=0', 'lat=0', 'lat=&lon=0']) expect((await handle(new Request(base + '/nominatim/reverse?' + query))).status).toBe(400);
    expect((await handle(post('/route', 'x'.repeat(17000)))).status).toBe(413); expect((await handle(post('/route', '{bad'))).status).toBe(400); expect(fetcher).not.toHaveBeenCalled();
  });
  it('maps profiles to FOSSGIS only and rejects invalid OSRM data without caching', async () => {
    const route = { code: 'Ok', routes: [{ distance: 1, duration: 1, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } }] }; const fetcher = vi.fn(async () => Response.json(route)); const { handle } = fixture({ fetch: fetcher });
    const result = await handle(post('/route', { points: [[0, 0], [1, 1]], mode: 'walk' })); expect(result.status).toBe(200); expect(String(fetcher.mock.calls[0][0])).toContain('/routed-foot/route/v1/driving/');
    const invalid = fixture({ fetch: async () => Response.json({ code: 'NoRoute' }) }); expect((await invalid.handle(post('/route', { points: [[0, 0], [1, 1]], mode: 'walk' }))).status).toBe(502); expect(invalid.kv.set).not.toHaveBeenCalled();
  });
  it('posts Valhalla requests and accepts only successful trips', async () => {
    const fetcher = vi.fn(async () => Response.json({ trip: { status: 0, legs: [], summary: { length: 1, time: 60 } } })); const { handle } = fixture({ fetch: fetcher });
    expect((await handle(post('/valhalla', { points: [[0, 0], [1, 1]], mode: 'drive', avoid: ['toll'] }))).status).toBe(200);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } }); expect(JSON.parse(fetcher.mock.calls[0][1].body).costing).toBe('auto');
    const failed = fixture({ fetch: async () => Response.json({ trip: { status: 442 } }) }); expect((await failed.handle(post('/valhalla', { points: [[0, 0], [1, 1]], mode: 'drive' }))).status).toBe(502);
  });
  it('returns retry hints at the provider limiter without calling upstream', async () => {
    const { handle, kv, fetcher } = fixture({ limiter: async () => ({ ok: false, retryAfter: 2 }) }); const response = await handle(new Request(base + '/nominatim/search?q=Berlin'));
    expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('2'); expect(fetcher).not.toHaveBeenCalled(); expect(kv.set).not.toHaveBeenCalled();
    const upstream = fixture({ fetch: async () => new Response('', { status: 429 }) }); const busy = await upstream.handle(new Request(base + '/nominatim/search?q=Berlin'));
    expect(busy.status).toBe(429); expect(busy.headers.get('retry-after')).toBe('1');
  });
  it('bounds request KV spending within an isolate', async () => {
    const { handle, kv } = fixture({ now: () => 0, maxRequestsPerSecond: 2 });
    for (const q of ['a', 'b']) expect((await handle(new Request(base + '/nominatim/search?q=' + q))).status).toBe(200);
    expect((await handle(new Request(base + '/nominatim/search?q=c'))).status).toBe(429); expect(kv.get).toHaveBeenCalledTimes(2);
  });
  it('honours the KV kill switch and per-provider disable while still serving cached answers', async () => {
    let config = { regions: 1 }; const kv = memoryKv(); const fetcher = vi.fn(async () => Response.json([]));
    const handle = createGeoHandler({ kv, fetch: fetcher, limiter: async () => ({ ok: true }), remoteConfig: async () => sanitizeRemoteConfig(config), enabled: ['nominatim', 'osrm'] });
    expect((await handle(new Request(base + '/nominatim/search?q=Berlin'))).status).toBe(200);
    config = { regions: 1, killed: true }; const killed = await handle(new Request(base + '/nominatim/search?q=Paris')); expect(killed.status).toBe(503); expect((await killed.json()).code).toBe('provider_disabled');
    const cached = await handle(new Request(base + '/nominatim/search?q=berlin')); expect(cached.status).toBe(200); expect(cached.headers.get('x-cache')).toBe('memory');
    config = { regions: 1, disabled: ['nominatim'] }; expect((await handle(new Request(base + '/nominatim/search?q=Paris'))).status).toBe(503);
    expect((await handle(new Request(base + '/valhalla', { method: 'POST', body: JSON.stringify({ points: [[0, 0], [1, 1]], mode: 'drive' }) }))).status).toBe(503);
    expect(await (await handle(new Request(base + '/config'))).json()).toEqual({ enabled: ['osrm'], limiter: 'declared' }); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('keeps upstream off until regions are declared but serves cache hits', async () => {
    const kv = memoryKv(); const fetcher = vi.fn(async () => Response.json([]));
    const handle = createGeoHandler({ kv, fetch: fetcher, enabled: ['nominatim'] });
    const refused = await handle(new Request(base + '/nominatim/search?q=Berlin')); expect(refused.status).toBe(503); expect((await refused.json()).code).toBe('global_limiter_unverified');
    expect(kv.get).toHaveBeenCalledWith(CONFIG_KEY); expect(fetcher).not.toHaveBeenCalled();
    const call = normalizeRequest({ method: 'GET', pathname: '/nominatim/search', params: new URLSearchParams('q=Berlin') });
    kv.store.set(await cacheKey('nominatim', call.key), { data: [{ cached: true }], expires: Date.now() + 60_000 });
    expect(await (await handle(new Request(base + '/nominatim/search?q=berlin'))).json()).toEqual([{ cached: true }]);
    const disabled = createGeoHandler({ kv, fetch: fetcher });
    expect((await disabled(new Request(base + '/nominatim/search?q=Berlin'))).status).toBe(200); expect((await disabled(new Request(base + '/nominatim/search?q=Rome'))).status).toBe(503);
    expect(await (await handle(new Request(base + '/config'))).json()).toEqual({ enabled: ['nominatim'], limiter: 'unverified' });
  });
  it('runs end to end with the real limiter once regions are declared', async () => {
    const kv = memoryKv(); kv.store.set(CONFIG_KEY, { regions: 1 }); let now = 50_000; const fetcher = vi.fn(async () => Response.json([]));
    const handle = createGeoHandler({ kv, fetch: fetcher, now: () => now, enabled: ['nominatim'], limiter: createKvLimiter(kv, { now: () => now, sleep: async ms => { now += ms; } }) });
    expect((await handle(new Request(base + '/nominatim/search?q=a'))).status).toBe(200); expect((await handle(new Request(base + '/nominatim/search?q=b'))).status).toBe(200);
    expect(now).toBe(51_000); expect(kv.store.get('rl:nominatim:50')).toBe(2); expect(kv.store.get('rl:nominatim:51')).toBe(1); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('handles CORS preflight and never caches oversized upstream data', async () => {
    const { handle, kv } = fixture({ fetch: async () => new Response('x'.repeat(300001)) });
    expect((await handle(new Request(base + '/route', { method: 'OPTIONS', headers: { Origin: 'https://trips.puter.com' } }))).status).toBe(204);
    expect((await handle(new Request(base + '/nominatim/search?q=Berlin'))).status).toBe(502); expect(kv.set).not.toHaveBeenCalled();
  });
  it('serves bodies over the cache cap without storing them, and caches Nominatim "no result" answers', async () => {
    const big = { code: 'Ok', routes: [{ distance: 1, duration: 1, geometry: 'x'.repeat(400_000) }] };
    const { handle, kv } = fixture({ fetch: async () => Response.json(big) });
    const response = await handle(post('/route', { points: [[0, 0], [1, 1]], mode: 'drive' }));
    expect(response.status).toBe(200); expect(response.headers.get('x-cache')).toBe('bypass'); expect(kv.set).not.toHaveBeenCalled();
    let now = 0; const sea = vi.fn(async () => Response.json({ error: 'Unable to geocode' })); const ocean = fixture({ fetch: sea, now: () => now });
    expect((await ocean.handle(new Request(base + '/nominatim/reverse?lat=0&lon=0'))).status).toBe(200);
    expect(ocean.kv.set.mock.calls[0][2]).toBe(86_400); now = 86_400_001;
    await ocean.handle(new Request(base + '/nominatim/reverse?lat=0&lon=0')); expect(sea).toHaveBeenCalledTimes(2);
  });
  it('maps upstream network failures to 502 without caching', async () => {
    const { handle, kv } = fixture({ fetch: async () => { throw new TypeError('network'); } });
    const response = await handle(new Request(base + '/nominatim/search?q=Berlin')); expect(response.status).toBe(502); expect((await response.json()).code).toBe('upstream_unavailable'); expect(kv.set).not.toHaveBeenCalled();
  });
});
