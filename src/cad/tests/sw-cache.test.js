import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** Run public/sw.js in a stand-in worker scope and hand back its fetch handler. */
function worker() {
  const listeners = {};
  const lookups = [];
  const self = { location: { origin: 'https://cad.example' }, addEventListener: (type, fn) => (listeners[type] = fn), skipWaiting() {}, clients: { claim() {} } };
  const caches = {
    match: async (req, opts) => (lookups.push({ url: req.url ?? req, opts }), new Response('cached')),
    open: async () => ({ put: async () => {}, keys: async () => [], delete: async () => {} }),
  };
  const fetch = async () => Promise.reject(new Error('offline'));
  new Function('self', 'caches', 'fetch', readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'))(self, caches, fetch);
  const request = async (path, init = {}) => {
    let answer;
    const req = new Request(`https://cad.example${path}`, init);
    listeners.fetch({ request: req, respondWith: (p) => (answer = p) });
    return answer && (await answer).text();
  };
  return { request, lookups, listeners };
}

describe('offline app shell', () => {
  it('finds the cached build files whatever Origin header the page sends', async () => {
    // The page asks for its script and style sheet with an Origin header (they are
    // crossorigin); on a host that answers "Vary: Origin" a plain lookup misses the
    // copies cached without one, and the app does not open offline.
    const sw = worker();
    expect(await sw.request('/assets/index-Gn0zDotr.js', { headers: { Origin: 'https://cad.example' } })).toBe('cached');
    expect(await sw.request('/manifest.json')).toBe('cached');
    expect(sw.lookups.map((l) => l.opts)).toEqual([{ ignoreVary: true }, { ignoreVary: true }]);
  });

  it('leaves other origins (the Puter SDK and API) alone', () => {
    const sw = worker();
    let answered = false;
    sw.listeners.fetch({ request: new Request('https://js.puter.com/v2/'), respondWith: () => (answered = true) });
    expect(answered).toBe(false);
    expect(sw.lookups).toEqual([]);
  });
});

/** The worker with a cache that really stores, a network that has `online` files, and `tabs` open windows. */
function workerWithCache(online, tabs) {
  const listeners = {};
  const stored = new Map();
  const self = {
    location: { origin: 'https://cad.example' },
    addEventListener: (type, fn) => (listeners[type] = fn),
    skipWaiting() {},
    clients: { claim() {}, matchAll: async () => Array.from({ length: tabs.count }, () => ({})) },
  };
  const cache = {
    put: async (req, res) => void stored.set(req.url ?? req, res),
    keys: async () => [...stored.keys()].map((url) => ({ url })),
    delete: async (req) => stored.delete(req.url ?? req),
  };
  const caches = { open: async () => cache, match: async (req) => stored.get(req.url ?? req)?.clone() };
  const fetch = async (req) => {
    const url = req.url ?? req;
    if (!online.has(url)) throw new Error('offline');
    return new Response(online.get(url));
  };
  new Function('self', 'caches', 'fetch', readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'))(self, caches, fetch);
  const precache = async (urls) => {
    let done;
    listeners.message({ data: { type: 'precache', urls }, waitUntil: (p) => (done = p) });
    await done;
  };
  const request = async (url) => {
    let answer;
    listeners.fetch({ request: new Request(url), respondWith: (p) => (answer = p) });
    return (await answer).text();
  };
  return { precache, request, stored };
}

describe('offline app shell after an update', () => {
  const A = 'https://cad.example/assets/';
  const oldFiles = [`${A}index-AAAAAAAA.js`, `${A}worker-AAAAAAAA.js`];
  const newFiles = [`${A}index-BBBBBBBB.js`, `${A}worker-BBBBBBBB.js`];

  it('keeps the files of the earlier build while a tab that runs it is open', async () => {
    const online = new Map(oldFiles.map((u) => [u, 'old']));
    const tabs = { count: 1 };
    const sw = workerWithCache(online, tabs);
    await sw.precache(oldFiles);
    // The app is updated; a second tab opens with the new build.
    online.clear();
    for (const u of newFiles) online.set(u, 'new');
    tabs.count = 2;
    await sw.precache(newFiles);
    // The first tab loads its DXF and DWG worker only now.
    expect(await sw.request(oldFiles[1])).toBe('old');
    expect(await sw.request(newFiles[1])).toBe('new');
  });

  it('drops the files of earlier builds once no other tab is open', async () => {
    const online = new Map([...oldFiles, ...newFiles].map((u) => [u, 'x']));
    const tabs = { count: 2 };
    const sw = workerWithCache(online, tabs);
    await sw.precache(oldFiles);
    await sw.precache(newFiles);
    tabs.count = 1;
    await sw.precache(newFiles);
    expect([...sw.stored.keys()].sort()).toEqual(newFiles);
  });
});
