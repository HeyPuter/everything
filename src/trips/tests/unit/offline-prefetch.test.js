// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { allowedURL, dropTiles, prefetchMapResources, prefetchTiles, templatePrefix } from '../../src/lib/offline/prefetch.js';
import { createCaches } from './helpers/fake-caches.js';

const TEMPLATE = 'https://tiles.openfreemap.org/planet/20261020_001001_pt/{z}/{x}/{y}.pbf';
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const style = (name) => ({
  version: 8, sprite: 'https://tiles.openfreemap.org/sprites/ofm_f384/ofm', glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: { openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
  layers: [{ id: `${name}-label`, type: 'symbol', layout: { 'text-font': ['Noto Sans Regular'] } }, { id: 'road', type: 'line' }],
});

function provider({ tiles = [TEMPLATE], tileBytes = 1000, status = () => 200 } = {}) {
  const calls = [];
  let active = 0;
  let peak = 0;
  const fetch = async (url, init) => {
    calls.push({ url, init });
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    const { pathname } = new URL(url);
    if (pathname.startsWith('/styles/')) return json(style(pathname));
    if (pathname === '/planet') return json({ tiles, maxzoom: 14 });
    const code = status(url);
    if (code !== 200) return new Response('', { status: code });
    return new Response(new Uint8Array(tileBytes), { headers: { 'content-type': 'application/x-protobuf' } });
  };
  return { fetch, calls, peak: () => peak };
}

describe('tile host policy', () => {
  it('only allows https URLs on OpenFreeMap', () => {
    expect(allowedURL('https://tiles.openfreemap.org/planet')).toBe('https://tiles.openfreemap.org/planet');
    for (const url of ['https://tile.openstreetmap.org/1/1/1.png', 'http://tiles.openfreemap.org/planet', 'https://tiles.openfreemap.org.evil.test/x',
      'https://user@tiles.openfreemap.org/x', 'https://tiles.openfreemap.org:8443/x', 'not a url']) expect(allowedURL(url)).toBeNull();
    expect(templatePrefix(TEMPLATE)).toBe('https://tiles.openfreemap.org/planet/20261020_001001_pt/');
  });
  it('refuses a dataset whose tiles live on another host', async () => {
    const { fetch } = provider({ tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'] });
    const cache = await createCaches().open('map');
    await expect(prefetchMapResources({ styleUrls: ['https://tiles.openfreemap.org/styles/positron'], fetch, cache })).rejects.toMatchObject({ code: 'tile_host_refused' });
    await expect(prefetchTiles({ template: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', ranges: [], cache, fetch })).rejects.toMatchObject({ code: 'tile_host_refused' });
  });
});

describe('map resources', () => {
  it('caches styles, sprites and glyph ranges, and the TileJSON only when adopted', async () => {
    const { fetch, calls } = provider();
    const cache = await createCaches().open('map');
    const styleUrls = ['https://tiles.openfreemap.org/styles/positron', 'https://tiles.openfreemap.org/styles/dark'];
    const result = await prefetchMapResources({ styleUrls, fetch, cache, adopt: () => false });
    expect(result).toEqual({ template: TEMPLATE, tilejsonUrl: 'https://tiles.openfreemap.org/planet', maxzoom: 14 });
    expect(await cache.match('https://tiles.openfreemap.org/planet')).toBeUndefined();
    expect(await cache.match(styleUrls[0])).toBeTruthy();
    expect(await cache.match('https://tiles.openfreemap.org/sprites/ofm_f384/ofm@2x.png')).toBeTruthy();
    expect(await cache.match('https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf')).toBeTruthy();
    expect(calls.every(({ init }) => init.credentials === 'omit' && init.referrerPolicy === 'origin')).toBe(true);
    await prefetchMapResources({ styleUrls, fetch, cache, adopt: () => true });
    expect(await cache.match('https://tiles.openfreemap.org/planet')).toBeTruthy();
  });
});

describe('tile downloads', () => {
  const ranges = [{ z: 3, x0: 0, x1: 3, y0: 0, y1: 3 }];
  it('downloads at most 4 at a time and skips tiles already on the device', async () => {
    const source = provider();
    const cache = await createCaches().open('map');
    await cache.put('https://tiles.openfreemap.org/planet/20261020_001001_pt/3/0/0.pbf', new Response(new Uint8Array(500), { headers: { 'content-length': '500' } }));
    const progress = [];
    const result = await prefetchTiles({ template: TEMPLATE, ranges, cache, fetch: source.fetch, onProgress: (value) => progress.push(value) });
    expect(result).toEqual({ count: 16, bytes: 15 * 1000 + 500, failed: 0, truncated: false, total: 16 });
    expect(source.calls).toHaveLength(15);
    expect(source.peak()).toBeLessThanOrEqual(4);
    expect(progress.at(-1)).toEqual({ done: 16, total: 16, bytes: 15_500 });
    expect((await cache.keys()).length).toBe(16);
  });
  it('stops once the byte budget is reached', async () => {
    const source = provider({ tileBytes: 1000 });
    const cache = await createCaches().open('map');
    const result = await prefetchTiles({ template: TEMPLATE, ranges, cache, fetch: source.fetch, maxBytes: 5000 });
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeLessThan(5000 + 4 * 1000);
    expect(source.calls.length).toBeLessThan(16);
  });
  it('waits once on 429 and gives up when the server keeps refusing', async () => {
    const waits = [];
    let first = true;
    const source = provider({ status: (url) => (url.endsWith('/3/1/1.pbf') && first ? (first = false, 429) : 200) });
    const cache = await createCaches().open('map');
    const result = await prefetchTiles({ template: TEMPLATE, ranges, cache, fetch: source.fetch, sleep: async (ms) => { waits.push(ms); } });
    expect(result.count).toBe(16);
    expect(waits).toEqual([5000]);
    const refusing = provider({ status: () => 429 });
    await expect(prefetchTiles({ template: TEMPLATE, ranges, cache: await createCaches().open('x'), fetch: refusing.fetch, sleep: async () => {} }))
      .rejects.toMatchObject({ code: 'tiles_refused' });
  });
  it('drops tiles of a dataset by prefix', async () => {
    const cache = await createCaches().open('map');
    await cache.put('https://tiles.openfreemap.org/planet/old/1/0/0.pbf', new Response('a'));
    await cache.put('https://tiles.openfreemap.org/styles/positron', new Response('{}'));
    await dropTiles(cache, { prefix: 'https://tiles.openfreemap.org/planet/old/' });
    expect((await cache.keys()).map((request) => request.url)).toEqual(['https://tiles.openfreemap.org/styles/positron']);
  });
});
