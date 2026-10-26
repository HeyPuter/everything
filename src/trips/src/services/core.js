export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
// Provider credits keep the wording their terms require; descriptive labels go through t() in the adapters.
export const attribution = Object.freeze({
  osm: { text: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright', license: 'ODbL' },
  photon: { text: 'Photon / © OpenStreetMap contributors', url: 'https://photon.komoot.io', license: 'ODbL' },
  nominatim: { text: 'Nominatim / © OpenStreetMap contributors', url: 'https://nominatim.org/', license: 'ODbL' },
  geoapify: { text: 'Powered by Geoapify / © OpenStreetMap contributors', url: 'https://www.geoapify.com/', license: 'ODbL' },
  route: { text: 'FOSSGIS / © OpenStreetMap contributors', url: 'https://routing.openstreetmap.de/about.html', license: 'ODbL' },
  valhalla: { text: 'Valhalla (FOSSGIS) / © OpenStreetMap contributors', url: 'https://valhalla1.openstreetmap.de/', license: 'ODbL' },
  ors: { text: 'openrouteservice / © OpenStreetMap contributors', url: 'https://openrouteservice.org/', license: 'ODbL' },
  metno: { text: 'MET Norway', url: 'https://www.met.no/en/free-meteorological-data/Licensing-and-crediting', license: 'CC BY 4.0' },
  openmeteo: { text: 'Weather data by Open-Meteo.com', url: 'https://open-meteo.com/', license: 'CC BY 4.0' },
  wikidata: { text: 'Wikidata', url: 'https://www.wikidata.org/', license: 'CC0' },
  openverse: { text: 'Openverse', url: 'https://openverse.org/' },
  commons: { text: 'Wikimedia Commons', url: 'https://commons.wikimedia.org/' },
  unsplash: { text: 'Unsplash', url: 'https://unsplash.com/?utm_source=puter_trips&utm_medium=referral', licenseURL: 'https://unsplash.com/license' },
});
export const DEFAULT_CONFIG = Object.freeze({
  providers: {
    tiles: ['openfreemap'], geocode: ['photon', 'nominatim'], pois: ['photon'], placeInfo: ['wikimedia'],
    route: ['geo-osrm', 'geo-valhalla', 'ors', 'straight'], weather: ['metno'], normals: ['nasa'], fx: ['frankfurter', 'fawaz'],
    publicHolidays: ['nager', 'openholidays'], schoolHolidays: ['openholidays'], subdivisions: ['openholidays'], images: ['unsplash', 'openverse', 'wikimedia'],
    flights: ['aerodatabox'],
    hazards: ['gdacs', 'dwd'],
  },
  geoWorker: null, disabled: [], nagerVersion: 4,
});
export const abortError = () => new DOMException('Aborted', 'AbortError');
export const MINUTE = 60_000;
const REFUSED = ['overpass-api.de', 'router.project-osrm.org', 'tile.openstreetmap.org'];
const refusedHost = host => REFUSED.some(name => host === name || host.endsWith('.' + name));
export const assertActive = signal => { if (signal?.aborted) throw abortError(); };
export function coordinate(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new RangeError('Invalid coordinates');
  return [lat, lng];
}
export function point(value) { if (!Array.isArray(value) || value.length !== 2) throw new RangeError('Expected [longitude,latitude]'); coordinate(value[1], value[0]); return [...value]; }
export function text(value, max = 200) { if (typeof value !== 'string' || value.length > max) throw new RangeError('Invalid text'); return value.trim(); }
export function country(value) { if (!/^[A-Z]{2}$/.test(value)) throw new RangeError('Invalid country'); return value; }
export function year(value) { if (!Number.isInteger(value) || value < 1900 || value > 2200) throw new RangeError('Invalid year'); return value; }
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const codePoint = value => (value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : '');
/** Provider text that may carry HTML, as plain text for textContent (tags dropped, entities decoded, control and bidi characters removed). */
export function plainText(value, max = 1000) {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/g, '')
    .replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (match, dec, hex, name) => dec ? codePoint(Number(dec)) : hex ? codePoint(Number.parseInt(hex, 16)) : ENTITIES[name.toLowerCase()] ?? match)
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
export function httpURL(value) { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; } }
export function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function delay(ms, signal) {
  assertActive(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    function cancel() { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(abortError()); }
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
const timeoutError = () => Object.assign(new Error('Provider request timed out'), { name: 'TimeoutError' });
const ignoreCleanup = operation => { try { Promise.resolve(operation()).catch(() => {}); } catch { /* Best-effort resource cleanup. */ } };
const cancelBody = response => { if (response?.body) ignoreCleanup(() => response.body.cancel()); };

function raceSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(abortError()); }
  return new Promise((resolve, reject) => {
    const cancel = () => reject(abortError());
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

async function deadline(operation, { signal, timeout }) {
  assertActive(signal);
  const controller = new AbortController();
  let timer;
  let cancel;
  const expired = new Promise((_resolve, reject) => {
    cancel = () => { reject(abortError()); controller.abort(); };
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => { reject(timeoutError()); controller.abort(); }, timeout);
  });
  try {
    const work = Promise.resolve().then(() => { assertActive(controller.signal); return operation(controller.signal); });
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export async function readTextBounded(response, maximum = 2_000_000, { signal } = {}) {
  assertActive(signal);
  const oversized = () => Object.assign(new Error('Provider payload too large'), { retryable: false });
  if (Number(response.headers.get('content-length')) > maximum) { cancelBody(response); throw oversized(); }
  if (!response.body?.getReader) {
    const cancel = () => cancelBody(response);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const value = await raceSignal(response.text(), signal);
      if (new TextEncoder().encode(value).length > maximum) throw oversized();
      return value;
    } finally { signal?.removeEventListener('abort', cancel); }
  }
  const reader = response.body.getReader();
  const cancel = () => ignoreCleanup(() => reader.cancel());
  signal?.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder(); let result = ''; let size = 0;
  try {
    while (true) {
      const { done, value } = await raceSignal(reader.read(), signal); if (done) break;
      size += value.byteLength;
      if (size > maximum) { cancel(); throw oversized(); }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } catch (cause) { cancel(); throw cause; }
  finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
}
export function createMemoryCache(limit = 512) {
  const items = new Map();
  return { async get(key) { return structuredClone(items.get(key) ?? null); }, async set(key, value) { items.delete(key); items.set(key, structuredClone(value)); while (items.size > limit) items.delete(items.keys().next().value); }, async clear() { items.clear(); } };
}
/** The database name partitions public-service queries by signed-in account. */
export function createPersistentCache(userId, { indexedDB = globalThis.indexedDB, limit = 512 } = {}) {
  if (!userId) throw new TypeError('A cache user identity is required');
  const memory = createMemoryCache(limit);
  let database;
  const open = () => database ??= new Promise((resolve, reject) => {
    if (!indexedDB) return resolve(null);
    const request = indexedDB.open(`trips-services:${userId}`, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('responses', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(() => null);
  const request = async (mode, operation) => {
    const db = await open(); if (!db) return null;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('responses', mode); const action = operation(transaction.objectStore('responses'));
      let result; action.onsuccess = () => { result = action.result; }; action.onerror = () => reject(action.error);
      transaction.oncomplete = () => resolve(result); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
    });
  };
  return {
    async get(key) { try { const result = await request('readonly', store => store.get(key)); return result?.value ?? await memory.get(key); } catch { return memory.get(key); } },
    async set(key, value) {
      await memory.set(key, value);
      try {
        await request('readwrite', store => store.put({ key, value, at: Date.now() }));
        const records = await request('readonly', store => store.getAll());
        if (records?.length > limit) {
          const db = await open(); const transaction = db.transaction('responses', 'readwrite');
          records.sort((a, b) => a.at - b.at).slice(0, records.length - limit).forEach(record => transaction.objectStore('responses').delete(record.key));
        }
      } catch { /* Cache failure must not prevent a provider result. */ }
    },
    async clear() { await memory.clear(); try { await request('readwrite', store => store.clear()); } catch { /* Unavailable cache. */ } },
  };
}
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reserved = new Set(['__proto__', 'constructor', 'prototype']);
const providerName = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(value) && !reserved.has(value);
export function sanitizeConfig(input) {
  if (!plainObject(input) || !plainObject(input.providers)) throw new TypeError('Invalid provider config');
  const providers = Object.fromEntries(Object.entries(DEFAULT_CONFIG.providers).map(([key, value]) => [key, [...value]]));
  for (const [key, values] of Object.entries(input.providers)) {
    if (!/^[a-z][a-zA-Z0-9-]{0,31}$/.test(key) || reserved.has(key)) continue;
    providers[key] = Array.isArray(values) ? [...new Set(values.filter(providerName))].slice(0, 20) : [];
  }
  return {
    providers,
    disabled: Array.isArray(input.disabled) ? [...new Set(input.disabled.filter(providerName))].slice(0, 100) : [],
    geoWorker: typeof input.geoWorker === 'string' && /^https:\/\/[a-z0-9-]+\.puter\.work\/?$/.test(input.geoWorker) ? input.geoWorker : null,
    nagerVersion: input.nagerVersion === 3 ? 3 : 4,
  };
}
export function createConfigLoader({ fetch: fetcher = globalThis.fetch, now = Date.now, url = '/config.json', timeout = 5000, online = () => globalThis.navigator?.onLine !== false } = {}) {
  let saved = sanitizeConfig(DEFAULT_CONFIG); let expires = 0; let pending;
  return async ({ refresh = false, offline = !online(), signal } = {}) => {
    if (offline || (!refresh && expires > now())) return structuredClone(saved);
    if (!pending) pending = (async () => {
      try {
        const input = await deadline(async attemptSignal => {
          const response = await fetcher(url, { cache: 'no-cache', credentials: 'omit', redirect: 'error', signal: attemptSignal });
          if (attemptSignal.aborted) { cancelBody(response); assertActive(attemptSignal); }
          if (!response.ok) { cancelBody(response); throw new Error('Configuration unavailable'); }
          return JSON.parse(await readTextBounded(response, 100_000, { signal: attemptSignal }));
        }, { timeout });
        saved = sanitizeConfig(input); expires = now() + HOUR;
      } catch { expires = now() + 30_000; }
      return structuredClone(saved);
    })().finally(() => { pending = null; });
    return raceSignal(pending, signal);
  };
}
/** `keys(provider)` returns the user's own API key for a keyed provider, or null. Keys never enter cache keys or results. */
export function createServiceContext({ userId, fetch: fetcher = globalThis.fetch, cache, config, keys, now = Date.now, online = () => globalThis.navigator?.onLine !== false, sleep = delay, retries = 1, timeout = 12_000, configTimeout = 5000 } = {}) {
  if (!userId) throw new TypeError('A service user identity is required');
  cache ??= createPersistentCache(userId);
  let lastConfig = sanitizeConfig(plainObject(config) ? config : DEFAULT_CONFIG);
  const configSource = typeof config === 'function' ? config : config ? async () => config : createConfigLoader({ fetch: fetcher, now, timeout: configTimeout, online });
  const loadConfig = async ({ offline = !online(), ...options } = {}) => {
    if (offline) return structuredClone(lastConfig);
    try {
      const value = await deadline(attemptSignal => configSource({ ...options, offline: false, signal: attemptSignal }), { timeout: configTimeout });
      lastConfig = sanitizeConfig(value);
    } catch { /* Use the latest valid settings while the config service is unavailable. */ }
    return structuredClone(lastConfig);
  };
  const pending = new Map(); const slots = new Map();
  const context = {
    cache, loadConfig, now,
    async key(provider) {
      if (typeof keys !== 'function') return null;
      try { const value = await keys(provider); return typeof value === 'string' && /^[\x21-\x7e]{8,256}$/.test(value) ? value : null; } catch { return null; }
    },
    async json(url, { signal, provider, interval = 1000, method = 'GET', body, headers = {}, retries: attempts = retries } = {}) {
      assertActive(signal);
      if (!httpURL(url) || refusedHost(new URL(url).hostname)) throw new Error('Provider endpoint refused');
      for (let attempt = 0; ; attempt++) {
        const start = Math.max(now(), slots.get(provider) ?? 0); slots.set(provider, start + interval);
        if (start > now()) await sleep(start - now(), signal);
        assertActive(signal);
        let response;
        try {
          const result = await deadline(async attemptSignal => {
            const incoming = await fetcher(url, { method, body: body === undefined ? undefined : JSON.stringify(body), signal: attemptSignal, credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } });
            if (attemptSignal.aborted) { cancelBody(incoming); assertActive(attemptSignal); }
            if (!incoming.ok) { cancelBody(incoming); return { response: incoming }; }
            const raw = await readTextBounded(incoming, 2_000_000, { signal: attemptSignal });
            return { response: incoming, data: JSON.parse(raw) };
          }, { signal, timeout });
          response = result.response;
          if (response.ok) return { data: result.data, headers: response.headers };
          if (response.status !== 429 && response.status < 500) throw Object.assign(new Error(`Provider HTTP ${response.status}`), { retryable: false, status: response.status });
        } catch (cause) {
          if (signal?.aborted || cause.name === 'AbortError') throw abortError();
          if (cause.retryable === false || attempt >= attempts) throw cause;
        }
        if (attempt >= attempts) throw Object.assign(new Error(`Provider HTTP ${response?.status}`), { status: response?.status });
        const retry = response?.headers.get('retry-after');
        const backoff = retry && /^\d+$/.test(retry) ? Math.min(30_000, Number(retry) * 1000) : 500 * 2 ** attempt;
        await sleep(backoff, signal);
      }
    },
    async run(capability, args, handlers, { ttl = DAY, signal, cacheVariant } = {}) {
      assertActive(signal); const isOnline = online(); const cfg = await raceSignal(loadConfig({ offline: !isOnline }), signal); assertActive(signal);
      const candidates = Object.hasOwn(cfg.providers, capability) ? cfg.providers[capability] : [];
      const providers = candidates.filter(provider => !cfg.disabled.includes(provider) && Object.hasOwn(handlers, provider) && typeof handlers[provider] === 'function');
      const key = String(userId) + ':' + capability + ':' + stable(args) + (cacheVariant ? ':' + stable(cacheVariant(cfg)) : '');
      const saved = await cache.get(key); assertActive(signal);
      if (saved && providers.includes(saved.provider) && saved.expires > now()) return { ...saved.result, cached: true, stale: saved.stale === true };
      if (!isOnline) return saved && providers.includes(saved.provider) ? { ...saved.result, cached: true, stale: true } : null;
      const sharedKey = key + ':' + providers.join(',');
      let operation = pending.get(sharedKey);
      if (!operation) {
        const controller = new AbortController();
        operation = { controller, consumers: 0 };
        const current = operation;
        operation.promise = (async () => {
          // `empty: true` (no matches) keeps trying later providers but is the answer if none has more; it is kept
          // only an hour when a later provider failed. An `estimate: true` answer never replaces an expired real one.
          const stale = saved && providers.includes(saved.provider) ? { ...saved.result, cached: true, stale: true } : null;
          let empty; let failed = false;
          const store = async (provider, value, lifetime = value.ttl ?? ttl) => {
            // Re-arm the old entry for the estimate's lifetime so retries back off while providers are down.
            if (value.estimate && stale && !saved.estimate) { await cache.set(key, { ...saved, expires: now() + lifetime, stale: true }); return stale; }
            const result = { data: value.data, attribution: value.attribution ?? [], provider, cached: false, stale: false };
            await cache.set(key, { provider, result, expires: now() + lifetime, ...(value.estimate ? { estimate: true } : {}) }); return result;
          };
          for (const provider of providers) {
            try {
              assertActive(controller.signal);
              const value = await handlers[provider](cfg, { signal: controller.signal });
              assertActive(controller.signal);
              if (value == null || value.data == null) continue;
              if (value.empty) { empty ??= [provider, value]; continue; }
              return await store(provider, value);
            } catch (cause) { if (cause.name === 'AbortError') throw cause; if (empty) failed = true; }
          }
          if (empty) return store(empty[0], empty[1], failed ? Math.min(HOUR, empty[1].ttl ?? ttl) : undefined);
          return stale;
        })().finally(() => { if (pending.get(sharedKey) === current) pending.delete(sharedKey); });
        pending.set(sharedKey, operation);
      }
      operation.consumers++;
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = () => { if (settled) return false; settled = true; signal?.removeEventListener('abort', cancel); operation.consumers--; return true; };
        const cancel = () => { if (finish()) { if (!operation.consumers) { pending.delete(sharedKey); operation.controller.abort(); } reject(abortError()); } };
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        operation.promise.then(value => { if (finish()) resolve(structuredClone(value)); }, cause => { if (finish()) reject(cause); });
      });
    },
  };
  return context;
}
