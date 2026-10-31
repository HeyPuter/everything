import { tileURL, tilesOf } from './tiles.js';

// OpenFreeMap is the only tile provider that may be prefetched (docs/services.md §5): at most 4 requests at a time,
// identified by the app's origin in Referer. Every URL is checked against this host before it is fetched.
export const TILE_HOST = 'tiles.openfreemap.org';
export const MAP_CACHE = 'trips-map-v1';
export const TILE_BYTES = 150 * 1024 * 1024;
export const MAX_TILES = 12_000;
export const PARALLEL = 4;
// Glyph ranges kept for each font: Latin, Latin Extended, Greek and Cyrillic. Other scripts are cached as viewed.
const GLYPH_RANGES = ['0-255', '256-511', '512-767', '768-1023', '1024-1279'];
const STYLE_BYTES = 5_000_000;
const MAX_FONTS = 12;

export class PrefetchError extends Error {
  constructor(code) { super(code); this.name = 'PrefetchError'; this.code = code; }
}

/** The URL when it is an https URL on the tile host, otherwise null. */
export function allowedURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === TILE_HOST && !url.port && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
const required = (value) => {
  const url = allowedURL(value);
  if (!url) throw new PrefetchError('tile_host_refused');
  return url;
};
/** The part of a tile template before `{z}`; every tile of one dataset version starts with it. */
export const templatePrefix = (template) => template.slice(0, template.indexOf('{z}'));

const init = (signal) => ({ credentials: 'omit', mode: 'cors', referrerPolicy: 'origin', signal });

async function getJSON(fetcher, url, signal) {
  const response = await fetcher(required(url), init(signal));
  if (!response.ok) throw Object.assign(new PrefetchError('map_unavailable'), { status: response.status });
  const text = await response.text();
  if (text.length > STYLE_BYTES) throw new PrefetchError('map_unavailable');
  return { text, data: JSON.parse(text), type: response.headers.get('content-type') ?? 'application/json' };
}
const stored = (body, type) => new Response(body, { headers: { 'content-type': type, 'x-trips-cached': String(Date.now()) } });

function fontStacks(style) {
  const stacks = new Set();
  for (const layer of Array.isArray(style.layers) ? style.layers : []) {
    const font = layer?.layout?.['text-font'];
    if (Array.isArray(font) && font.length && font.every((name) => typeof name === 'string' && name.length <= 100)) stacks.add(font.join(','));
    if (stacks.size >= MAX_FONTS) break;
  }
  return [...stacks];
}

/**
 * Caches the styles, their sprites and common glyph ranges, and reads the vector TileJSON. The TileJSON is cached only
 * when `adopt(template)` says so, so the offline copy always matches the tiles on the device.
 */
export async function prefetchMapResources({ styleUrls, fetch: fetcher = globalThis.fetch, cache, signal, adopt = () => true }) {
  const tilejsons = new Map();
  const extras = new Set();
  for (const styleUrl of styleUrls.filter(Boolean)) {
    const style = await getJSON(fetcher, styleUrl, signal);
    if (style.data?.version !== 8 || !style.data.sources || typeof style.data.sources !== 'object') throw new PrefetchError('map_unavailable');
    await cache.put(required(styleUrl), stored(style.text, style.type));
    for (const source of Object.values(style.data.sources)) {
      if (source?.type === 'vector' && typeof source.url === 'string') tilejsons.set(required(source.url), null);
    }
    const sprites = (Array.isArray(style.data.sprite) ? style.data.sprite.map((entry) => entry?.url) : [style.data.sprite]).filter((url) => typeof url === 'string' && allowedURL(url));
    for (const sprite of sprites.slice(0, 4)) for (const suffix of ['.json', '.png', '@2x.json', '@2x.png']) extras.add(sprite + suffix);
    const glyphs = typeof style.data.glyphs === 'string' && allowedURL(style.data.glyphs.replace('{fontstack}', 'f').replace('{range}', 'r')) ? style.data.glyphs : null;
    if (glyphs) for (const stack of fontStacks(style.data)) for (const range of GLYPH_RANGES) extras.add(new URL(glyphs.replace('{fontstack}', stack).replace('{range}', range)).href);
  }
  // The basemap's vector source comes first; other sources are not kept offline.
  if (!tilejsons.size) throw new PrefetchError('map_unavailable');
  const [tilejsonUrl] = tilejsons.keys();
  const tilejson = await getJSON(fetcher, tilejsonUrl, signal);
  const tiles = Array.isArray(tilejson.data?.tiles) ? tilejson.data.tiles : [];
  const template = tiles.find((value) => typeof value === 'string' && value.length <= 500 && /\{z\}.*\{x\}.*\{y\}/.test(value) && allowedURL(value));
  if (!template) throw new PrefetchError('tile_host_refused');
  if (await adopt(template)) await cache.put(tilejsonUrl, stored(tilejson.text, tilejson.type));
  await runPool([...extras], async (url) => {
    if (await cache.match(url)) return;
    const response = await fetcher(required(url), init(signal));
    if (response.ok) await cache.put(url, stored(await response.arrayBuffer(), response.headers.get('content-type') ?? 'application/octet-stream'));
    else void response.body?.cancel().catch(() => {});
  }, { signal, tolerate: true });
  return { template, tilejsonUrl, maxzoom: Number.isInteger(tilejson.data.maxzoom) ? tilejson.data.maxzoom : 14 };
}

async function runPool(items, task, { signal, parallel = PARALLEL, tolerate = false } = {}) {
  const queue = items[Symbol.iterator]();
  let failure;
  const worker = async () => {
    for (let next = queue.next(); !next.done && !failure; next = queue.next()) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      try { await task(next.value); } catch (error) { if (!tolerate || error?.name === 'AbortError') { failure ??= error; throw error; } }
    }
  };
  const results = await Promise.allSettled(Array.from({ length: parallel }, worker));
  const rejected = results.find((result) => result.status === 'rejected');
  if (failure ?? rejected) throw failure ?? rejected.reason;
}

const sizeOf = async (response) => Number(response.headers.get('content-length')) || (await response.clone().blob()).size;

/**
 * Downloads the tiles of `ranges` into `cache`, 4 at a time, stopping once `maxBytes` are on the device. Tiles already
 * cached count toward the total without a request. Resolves `{count, bytes, failed, truncated}`.
 */
export async function prefetchTiles({ template, ranges, cache, fetch: fetcher = globalThis.fetch, signal, maxBytes = TILE_BYTES, maxTiles = MAX_TILES,
  onProgress = () => {}, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  required(tileURL(template, { z: 0, x: 0, y: 0 }));
  const tiles = [...tilesOf(ranges, maxTiles)];
  const state = { count: 0, bytes: 0, failed: 0, done: 0, truncated: false, total: tiles.length };
  let refusals = 0;
  const report = () => onProgress({ done: state.done, total: state.total, bytes: state.bytes });
  await runPool(tiles, async (tile) => {
    if (state.bytes >= maxBytes) { state.truncated = true; return; }
    const url = required(tileURL(template, tile));
    const hit = await cache.match(url);
    if (hit) { state.bytes += await sizeOf(hit); state.count++; state.done++; report(); return; }
    for (let attempt = 0; ; attempt++) {
      const response = await fetcher(url, init(signal));
      if (response.status === 429 && attempt === 0) {
        void response.body?.cancel().catch(() => {});
        const wait = Number(response.headers.get('retry-after'));
        await sleep(Math.min(Number.isFinite(wait) && wait > 0 ? wait * 1000 : 5000, 60_000));
        continue;
      }
      if (response.status === 429 || response.status === 403) {
        void response.body?.cancel().catch(() => {});
        if (++refusals >= 3) throw new PrefetchError('tiles_refused');
        state.failed++;
        break;
      }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); state.failed++; break; }
      const body = await response.arrayBuffer();
      await cache.put(url, new Response(body, { headers: { 'content-type': response.headers.get('content-type') ?? 'application/x-protobuf', 'content-length': String(body.byteLength) } }));
      state.bytes += body.byteLength; state.count++;
      break;
    }
    state.done++; report();
  }, { signal });
  if (state.failed > Math.max(20, state.total / 5)) throw new PrefetchError('tiles_failed');
  return { count: state.count, bytes: state.bytes, failed: state.failed, truncated: state.truncated, total: state.total };
}

/** Removes cached tiles in `urls`, or every tile starting with `prefix`. */
export async function dropTiles(cache, { urls, prefix }) {
  if (urls) { for (const url of urls) await cache.delete(url); return; }
  if (!prefix) return;
  for (const request of await cache.keys()) if (request.url.startsWith(prefix)) await cache.delete(request);
}
