// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createCaches } from './helpers/fake-caches.js';
import { precacheList } from '../../tools/vite-pwa.mjs';

const SCOPE = 'https://trips.puter.com/';
const ASSETS = ['./', './index.html', './assets/app-abc.js', './manifest.webmanifest'];
const source = readFileSync(new URL('../../src/sw.js', import.meta.url), 'utf8');

function boot({ version = 'v2', online = true, caches = null } = {}) {
  const requests = [];
  const fetch = vi.fn(async (request) => {
    const url = typeof request === 'string' ? request : request.url;
    requests.push(url);
    if (!online) throw new TypeError('Failed to fetch');
    return new Response(`network:${url}`, { status: 200 });
  });
  const storage = caches ?? createCaches({ fetch });
  const listeners = {};
  const self = { registration: { scope: SCOPE }, addEventListener: (type, listener) => { listeners[type] = listener; }, clients: { claim: vi.fn(async () => {}) }, skipWaiting: vi.fn() };
  const code = source.replace('__SW_VERSION__', JSON.stringify(version)).replace('__SW_ASSETS__', JSON.stringify(ASSETS));
  new Function('self', 'caches', 'fetch', code)(self, storage, fetch);
  const worker = {
    caches: storage, fetch, requests, self,
    setOnline(value) { online = value; },
    async lifecycle(type) { let done; listeners[type]({ waitUntil: (promise) => { done = promise; } }); await done; },
    async message(data) { let done; listeners.message({ data, waitUntil: (promise) => { done = promise; } }); await done; },
    /** Resolves the response the worker gave, or 'pass' when it left the request to the browser. */
    async request(url, { method = 'GET', mode = 'cors' } = {}) {
      let responded = null;
      const pending = [];
      listeners.fetch({ request: { url, method, mode }, respondWith: (value) => { responded = value; }, waitUntil: (value) => { pending.push(value); } });
      if (!responded) return 'pass';
      const response = await responded;
      await Promise.all(pending);
      return response;
    },
  };
  return worker;
}

describe('service worker caching', () => {
  it('precaches the app shell and leaves sync, config, the worker bundle and the SDK alone', async () => {
    const sw = boot();
    await sw.lifecycle('install');
    expect([...sw.caches.stores.get('trips-shell-v2').items.keys()]).toEqual(ASSETS.map((path) => new URL(path, SCOPE).href));
    for (const url of [
      'https://trips-abcdefghij.puter.work/api', 'https://trips.puter.com/config.json', 'https://trips.puter.com/worker/trips-worker.js',
      'https://js.puter.com/v2/', 'https://api.puter.com/whoami', 'https://photon.komoot.io/api?q=x',
    ]) expect(await sw.request(url)).toBe('pass');
    expect(await sw.request('https://trips-abcdefghij.puter.work/api', { method: 'POST' })).toBe('pass');
    sw.fetch.mockClear();
    await sw.request('https://trips.puter.com/config.json');
    expect([...sw.caches.stores.values()].some((cache) => [...cache.items.keys()].some((key) => key.includes('config.json') || key.includes('puter.work')))).toBe(false);
  });

  it('serves hashed assets from the cache and navigations from the network, falling back to the shell', async () => {
    const sw = boot();
    await sw.lifecycle('install');
    sw.requests.length = 0;
    expect(await (await sw.request('https://trips.puter.com/assets/app-abc.js')).text()).toBe('network:https://trips.puter.com/assets/app-abc.js');
    expect(sw.requests).toEqual([]);
    expect(await (await sw.request('https://trips.puter.com/?x=1', { mode: 'navigate' })).text()).toBe('network:https://trips.puter.com/?x=1');
    sw.setOnline(false);
    const offline = await sw.request('https://trips.puter.com/?x=1', { mode: 'navigate' });
    expect(await offline.text()).toBe(`network:${SCOPE}`);
    const lazy = await sw.request('https://trips.puter.com/assets/late-def.js').catch((error) => error);
    expect(lazy).toBeInstanceOf(TypeError);
  });

  it('keeps the previous build for open tabs and removes older ones on activation', async () => {
    const caches = createCaches();
    for (const name of ['trips-shell-v0', 'trips-shell-v1', 'trips-map-v1']) await caches.open(name);
    const sw = boot({ caches });
    await sw.lifecycle('install');
    await sw.lifecycle('activate');
    expect((await caches.keys()).filter((name) => name !== 'trips-sw-state')).toEqual(['trips-shell-v1', 'trips-map-v1', 'trips-shell-v2']);
    expect(sw.self.clients.claim).toHaveBeenCalled();
    await sw.message({ type: 'trips:skip-waiting' });
    expect(sw.self.skipWaiting).toHaveBeenCalled();
  });

  it('serves prefetched tiles and the kept map copy offline, and caches glyphs when online', async () => {
    const sw = boot();
    const map = await sw.caches.open('trips-map-v1');
    await map.put('https://tiles.openfreemap.org/planet/v1/3/4/2.pbf', new Response('tile'));
    await map.put('https://tiles.openfreemap.org/planet', new Response('{"kept":true}'));
    expect(await (await sw.request('https://tiles.openfreemap.org/planet/v1/3/4/2.pbf')).text()).toBe('tile');
    expect(await (await sw.request('https://tiles.openfreemap.org/planet')).text()).toBe('network:https://tiles.openfreemap.org/planet');
    expect(await (await sw.request('https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf')).text()).toContain('network:');
    expect(await map.match('https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf')).toBeTruthy();
    expect(await map.match('https://tiles.openfreemap.org/planet/v1/3/4/3.pbf')).toBeUndefined();
    await sw.request('https://tiles.openfreemap.org/planet/v1/3/4/3.pbf');
    expect(await map.match('https://tiles.openfreemap.org/planet/v1/3/4/3.pbf')).toBeUndefined();
    sw.setOnline(false);
    expect(await (await sw.request('https://tiles.openfreemap.org/planet')).text()).toBe('{"kept":true}');
  });

  it('refuses sync and provider traffic while working offline, but never the SDK or identity', async () => {
    const sw = boot();
    await sw.message({ type: 'trips:force-offline', on: true });
    for (const url of ['https://trips-abcdefghij.puter.work/api', 'https://api.puter.com/drivers/call', 'https://photon.komoot.io/api?q=x']) {
      const response = await sw.request(url, { method: url.endsWith('/api') ? 'POST' : 'GET' });
      expect(response.type).toBe('error');
    }
    expect(await sw.request('https://js.puter.com/v2/')).toBe('pass');
    expect(await sw.request('https://api.puter.com/whoami')).toBe('pass');
    expect((await sw.request('https://tiles.openfreemap.org/planet/v1/9/9/9.pbf')).type).toBe('error');
    const restarted = boot({ caches: sw.caches });
    expect((await restarted.request('https://trips-abcdefghij.puter.work/api', { method: 'POST' })).type).toBe('error');
    await restarted.message({ type: 'trips:force-offline', on: false });
    expect(await restarted.request('https://trips-abcdefghij.puter.work/api', { method: 'POST' })).toBe('pass');
  });
});

describe('precache list', () => {
  it('adds the shell and public files and skips maps, locale chunks, the worker bundle and the service worker', () => {
    expect(precacheList(['index.html', 'assets/app-1.js', 'assets/app-1.js.map', 'assets/locale-de-1.js', 'sw.js', 'worker/trips-worker.js'], ['manifest.webmanifest', 'icons/icon-192.png']))
      .toEqual(['./', './index.html', './assets/app-1.js', './manifest.webmanifest', './icons/icon-192.png']);
  });
});
