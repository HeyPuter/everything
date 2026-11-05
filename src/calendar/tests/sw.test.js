import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Harness for public/sw.js: evaluate the worker source against a mocked
 * ServiceWorker global surface (self, caches, fetch) and drive its lifecycle
 * events directly. URLs are resolved the way a real SW at the scope root
 * resolves them, so relative './x' entries behave as deployed.
 */
const SW_SRC = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/sw.js'),
  'utf8',
);
const ORIGIN = 'https://calendar.example';
const SCOPE = `${ORIGIN}/`;

function makeCacheStore() {
  const stores = new Map(); // name -> Map(absUrl -> Response)
  const resolve = (url) => new URL(url, SCOPE).href;
  const api = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async add(url) {
          const abs = resolve(url);
          const resp = await globalThis.__swFetch(abs);
          if (!resp || !resp.ok) throw new Error(`add failed: ${abs}`);
          store.set(abs, resp.clone());
        },
        async put(url, resp) {
          store.set(resolve(typeof url === 'string' ? url : url.url), resp);
        },
        async match(url) {
          return store.get(resolve(typeof url === 'string' ? url : url.url)) || undefined;
        },
        async keys() {
          return [...store.keys()].map((href) => ({ url: href }));
        },
        async delete(url) {
          return store.delete(resolve(typeof url === 'string' ? url : url.url));
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
    stores,
  };
  return api;
}

/** A minimal Response stand-in with the fields sw.js reads. */
function resp(body, { ok = true, status = 200, type = 'basic', redirected = false } = {}) {
  return {
    ok,
    status,
    type,
    body,
    redirected,
    headers: {},
    clone() {
      return resp(body, { ok, status, type, redirected });
    },
    async text() {
      return String(body);
    },
    async blob() {
      return String(body);
    },
  };
}

/** Constructible Response for the worker's re-wrap path (plus static error). */
class ResponseStub {
  constructor(body, init = {}) {
    return resp(String(body), { status: init.status ?? 200 });
  }
  static error() {
    return resp('', { ok: false, status: 0, type: 'error' });
  }
}

function loadSw({ fetchImpl }) {
  const listeners = {};
  const self = {
    addEventListener: (name, fn) => (listeners[name] = fn),
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}) },
    registration: { scope: SCOPE },
    location: new URL(SCOPE),
  };
  const caches = makeCacheStore();
  globalThis.__swFetch = fetchImpl;
  const importScripts = vi.fn();
  const run = new Function('self', 'caches', 'fetch', 'Response', 'importScripts', SW_SRC);
  run(self, caches, fetchImpl, ResponseStub, importScripts);
  return { listeners, caches, self, importScripts };
}

/** Drive an event handler and await its waitUntil/respondWith work. */
async function fire(handler, extra = {}) {
  let settled;
  const event = {
    waitUntil: (p) => (settled = p),
    respondWith: (p) => (settled = p),
    ...extra,
  };
  handler(event);
  return settled;
}

/** Dispatch a fetch event; returns the response promise and the anchored work. */
function dispatchFetch(listeners, url, { mode = 'no-cors' } = {}) {
  const waits = [];
  let responded;
  listeners.fetch({
    request: { url, method: 'GET', mode },
    waitUntil: (p) => waits.push(p),
    respondWith: (p) => (responded = p),
  });
  return { responded, waits };
}

const INDEX_HTML = `<!doctype html><html><head>
<link rel="stylesheet" crossorigin href="./assets/index-CSSHASH1.css">
<script type="module" crossorigin src="./assets/index-JSHASH99.js"></script>
</head><body></body></html>`;

function networkOf(routes) {
  return vi.fn(async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    const path = new URL(url, SCOPE).pathname;
    if (path in routes) return routes[path];
    return resp('', { ok: false, status: 404 });
  });
}

describe('service worker push', () => {
  it("imports Puter's push script and adds no push listener of its own", () => {
    const { listeners, importScripts } = loadSw({ fetchImpl: networkOf({}) });
    expect(importScripts).toHaveBeenCalledWith('https://js.puter.com/push-sw.js');
    expect(listeners.push).toBeUndefined();
    expect(listeners.notificationclick).toBeUndefined();
  });
});

describe('service worker install', () => {
  let routes;
  beforeEach(() => {
    routes = {
      '/': resp(INDEX_HTML),
      '/index.html': resp(INDEX_HTML),
      '/site.webmanifest': resp('{}'),
      '/favicon.ico': resp('i'),
      '/favicon-32x32.png': resp('i'),
      '/icon-192.png': resp('i'),
      '/icon-512.png': resp('i'),
      '/apple-touch-icon.png': resp('i'),
      '/assets/index-CSSHASH1.css': resp('css'),
      '/assets/index-JSHASH99.js': resp('js'),
    };
  });

  it('precaches the hashed bundles named by index.html, so the FIRST visit can boot offline', async () => {
    const { listeners, caches } = loadSw({ fetchImpl: networkOf(routes) });
    await fire(listeners.install);
    const store = [...caches.stores.values()][0];
    const cached = [...store.keys()];
    expect(cached).toContain(`${ORIGIN}/assets/index-JSHASH99.js`);
    expect(cached).toContain(`${ORIGIN}/assets/index-CSSHASH1.css`);
    expect(cached).toContain(`${ORIGIN}/index.html`);
  });

  it('still installs when index.html is unfetchable (no assets to discover)', async () => {
    delete routes['/index.html'];
    delete routes['/'];
    const { listeners, self } = loadSw({ fetchImpl: networkOf(routes) });
    await fire(listeners.install);
    expect(self.skipWaiting).toHaveBeenCalled();
  });

  it('a missing asset never fails install (allSettled semantics)', async () => {
    delete routes['/assets/index-CSSHASH1.css'];
    const { listeners, caches, self } = loadSw({ fetchImpl: networkOf(routes) });
    await fire(listeners.install);
    expect(self.skipWaiting).toHaveBeenCalled();
    const store = [...caches.stores.values()][0];
    expect([...store.keys()]).toContain(`${ORIGIN}/assets/index-JSHASH99.js`);
  });

  it('serves a cached asset instantly and anchors the revalidation via event.waitUntil', async () => {
    // Without the waitUntil anchor the browser may terminate the worker the
    // moment respondWith settles, sporadically discarding the refresh — a
    // changed manifest/icon could then stay stale across visits indefinitely.
    const { listeners, caches } = loadSw({ fetchImpl: networkOf(routes) });
    await fire(listeners.install);
    routes['/site.webmanifest'] = resp('{"v":2}'); // server updated after install

    const { responded, waits } = dispatchFetch(listeners, `${ORIGIN}/site.webmanifest`);
    const out = await responded;
    expect(await out.text()).toBe('{}'); // the stale copy, instantly
    expect(waits.length).toBe(1); // the background refresh is anchored
    await Promise.all(waits);
    const store = [...caches.stores.values()][0];
    expect(await store.get(`${ORIGIN}/site.webmanifest`).text()).toBe('{"v":2}'); // refresh landed
  });

  it('a shell navigation after a deploy evicts the previous build\'s hashed bundles', async () => {
    const { listeners, caches } = loadSw({ fetchImpl: networkOf(routes) });
    await fire(listeners.install);

    // A new build ships: index.html now names different hashed bundles. The
    // cache name is stable across deploys, so without pruning every old
    // bundle pair would sit in CacheStorage forever.
    const NEW_HTML = INDEX_HTML.replace('CSSHASH1', 'CSSHASH2').replace('JSHASH99', 'JSHASH100');
    routes['/'] = resp(NEW_HTML);
    routes['/index.html'] = resp(NEW_HTML);
    routes['/assets/index-CSSHASH2.css'] = resp('css2');
    routes['/assets/index-JSHASH100.js'] = resp('js2');

    const { responded, waits } = dispatchFetch(listeners, `${ORIGIN}/`, { mode: 'navigate' });
    await responded;
    await Promise.all(waits);

    const store = [...caches.stores.values()][0];
    const cached = [...store.keys()];
    expect(cached).not.toContain(`${ORIGIN}/assets/index-JSHASH99.js`);
    expect(cached).not.toContain(`${ORIGIN}/assets/index-CSSHASH1.css`);
    // Everything that is not a superseded hashed bundle is untouched.
    expect(cached).toContain(`${ORIGIN}/icon-192.png`);
    expect(cached).toContain(`${ORIGIN}/site.webmanifest`);
    // And the refreshed shell is what the next offline boot serves.
    expect(await store.get(`${ORIGIN}/index.html`).text()).toBe(NEW_HTML);
  });

  it('re-wraps a redirected shell navigation before caching it', async () => {
    // A cached response with redirected=true is rejected by the browser when
    // served for a later navigation ("a redirected response was used for a
    // request whose redirect mode is not 'follow'") — the offline boot the
    // cache exists for would hard-fail.
    const { listeners, caches } = loadSw({ fetchImpl: networkOf(routes) });
    await fire(listeners.install);

    routes['/'] = resp(INDEX_HTML, { redirected: true });
    const { responded, waits } = dispatchFetch(listeners, `${ORIGIN}/`, { mode: 'navigate' });
    await responded;
    await Promise.all(waits);

    const store = [...caches.stores.values()][0];
    const cached = store.get(`${ORIGIN}/index.html`);
    expect(cached.redirected).toBe(false); // safe to serve to a navigation
    expect(await cached.text()).toBe(INDEX_HTML); // same body
  });

  it('falls through to the network for an uncached asset', async () => {
    const { listeners } = loadSw({ fetchImpl: networkOf(routes) });
    await fire(listeners.install);
    routes['/extra.png'] = resp('pixels');
    const { responded } = dispatchFetch(listeners, `${ORIGIN}/extra.png`);
    expect(await (await responded).text()).toBe('pixels');
  });
});
