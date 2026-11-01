/**
 * Service worker TEMPLATE for Downloader — not served as-is.
 * The build (vite.config.js) fills in the version and precache placeholders
 * below and emits the result as dist/sw.js. Registered by src/main.js in production.
 */

const VERSION = '__VERSION__';
const ASSETS = __ASSETS__;
const CACHE = `downloader-${VERSION}`;
const SDK_HOST = 'js.puter.com';
const SDK_CACHE = 'downloader-sdk';
const SDK_TTL = 24 * 60 * 60 * 1000;

const MATCH = { ignoreVary: true, ignoreSearch: false };

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const old = keys.filter((k) => k !== CACHE && k !== SDK_CACHE);
    const sdk = await caches.open(SDK_CACHE);
    for (const k of old) {
      const cache = await caches.open(k);
      for (const req of await cache.keys()) {
        if (new URL(req.url).hostname !== SDK_HOST) continue;
        if (await sdk.match(req, MATCH)) continue;
        const res = await cache.match(req, MATCH);
        if (res) await sdk.put(req, res);
      }
    }
    await Promise.all(old.map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Puter SDK cache strategy: stale-while-revalidate with TTL
  if (url.hostname === SDK_HOST) {
    const stampReq = new Request(`${req.url}${req.url.includes('?') ? '&' : '?'}__sw_fetched_at__`);
    const refresh = (cache) => fetch(req).then((res) => {
      if (res && (res.ok || res.type === 'opaque')) {
        return cache.put(req, res.clone())
          .then(() => cache.put(stampReq, new Response(String(Date.now()))))
          .then(() => res);
      }
      return res;
    });
    event.respondWith(caches.open(SDK_CACHE).then(async (cache) => {
      const cached = await cache.match(req, MATCH);
      if (!cached) return refresh(cache).catch(() => Response.error());
      const stamp = await cache.match(stampReq, MATCH);
      const fetchedAt = stamp ? Number(await stamp.text()) : 0;
      if (Date.now() - fetchedAt >= SDK_TTL) {
        event.waitUntil(refresh(cache).catch(() => {}));
      }
      return cached;
    }));
    return;
  }

  if (url.origin !== location.origin) return;

  // App-shell navigation
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./', { ...MATCH, ignoreSearch: true })
        .then((cached) => cached || fetch(req))
    );
    return;
  }

  // Static assets: cache-first
  event.respondWith(
    caches.match(req, MATCH).then((cached) => cached || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
      }
      return res;
    }))
  );
});
