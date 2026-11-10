/**
 * Calendar service worker — makes the app installable and lets the static shell
 * load offline. It is deliberately conservative: it caches ONLY the static app
 * shell (own-origin build output) plus the Puter SDK script, and NEVER touches
 * Puter's data/auth API. That boundary is what keeps offline support from ever
 * creating sync issues — no user data ever passes through this cache.
 *
 * Shipped verbatim from public/ to the dist root by Vite, so it registers at
 * "/sw.js" with scope "/".
 *
 * Caching strategy:
 *   - navigations (HTML) → network-first, cached "./index.html" fallback. This
 *     guarantees a freshly-deployed app is picked up on the next online load
 *     (the classic "stuck on a stale PWA" footgun is avoided), while still
 *     booting when offline.
 *   - same-origin static assets → stale-while-revalidate. Vite content-hashes
 *     JS/CSS, so their URLs are immutable; serving cache-first with a background
 *     refresh is safe and instant.
 *   - js.puter.com (the SDK) → network-first with an opaque-cache fallback, so a
 *     cold start can boot offline. A bad/partial cache self-heals on the next
 *     online load; worst case it degrades to the app's existing 8s SDK-load
 *     timeout, never a hard brick.
 *   - everything else cross-origin (api.puter.com, telemetry, …) → not
 *     intercepted at all (straight to network, never cached).
 *
 * NOTE: skipWaiting()+clients.claim() is safe here specifically because the app
 * has ZERO dynamic import()s — a live client never fetches a hashed chunk
 * mid-session, so purging old caches on activate can't 404 a still-needed asset.
 * If lazy chunks are ever introduced, either keep the previous cache alongside
 * the current one in activate, or drop skipWaiting for activate-on-next-load.
 */
const CACHE = 'cal-shell-v2';
const SDK_ORIGIN = 'https://js.puter.com';

// Puter push notifications (see src/js/push.js). It only adds push, message
// and notificationclick listeners, and ignores pushes that aren't Puter's.
importScripts(`${SDK_ORIGIN}/push-sw.js`);

// Minimal, always-present shell. Hashed JS/CSS are cached lazily on first fetch
// (their names change every build, so they can't be listed here). Precaching
// index.html + icons + manifest is enough to boot and satisfy installability.
const SHELL = [
  './',
  './index.html',
  './site.webmanifest',
  './favicon.ico',
  './favicon-32x32.png',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

// The hashed JS/CSS bundles index.html loads (e.g. "./assets/index-<hash>.js").
// Their names change every build, so they can't be listed in SHELL — they are
// discovered by reading the just-fetched index.html at install time.
const ASSET_URL_RE = /["'](\.?\/?assets\/[^"']+)["']/g;

/** Precache the hashed bundles the cached shell boots from. Without this the
 *  FIRST-ever visit never caches them: they were fetched before this worker
 *  existed, so nothing lazy-caches them, and the first offline open would
 *  serve the precached index.html only to fail on its assets. */
async function precacheShellAssets(cache) {
  try {
    const shell = await cache.match('./index.html');
    if (!shell) return;
    const html = await shell.clone().text();
    const urls = new Set();
    for (const m of html.matchAll(ASSET_URL_RE)) urls.add(m[1]);
    await Promise.allSettled([...urls].map((url) => cache.add(url)));
  } catch {
    /* never fail install over asset discovery */
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // addAll is atomic; ignore individual misses so one 404 can't fail install.
      .then((cache) =>
        Promise.allSettled(SHELL.map((url) => cache.add(url))).then(() =>
          precacheShellAssets(cache),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Cache-worthy only if it's a real, complete same-origin response. */
function isCacheableAsset(resp) {
  return resp && resp.ok && resp.type === 'basic';
}

/** Drop hashed bundles the current shell no longer references. The cache name
 *  is stable across deploys, so without this every deploy's JS/CSS would
 *  accrete in CacheStorage forever. Safe at any point after the fresh
 *  index.html is stored: a cache-served boot can only load the bundles that
 *  HTML names, and a live client never fetches a hashed chunk mid-session
 *  (see the skipWaiting note above). */
async function pruneStaleAssets(cache) {
  try {
    const shell = await cache.match('./index.html');
    if (!shell) return;
    const html = await shell.clone().text();
    const current = new Set();
    for (const m of html.matchAll(ASSET_URL_RE)) current.add(new URL(m[1], self.location.href).pathname);
    if (!current.size) return; // never wipe the assets over an unreadable shell
    const keys = await cache.keys();
    const stale = keys.filter((req) => {
      const url = new URL(req.url);
      return url.origin === self.location.origin && url.pathname.includes('/assets/') && !current.has(url.pathname);
    });
    await Promise.all(stale.map((req) => cache.delete(req)));
  } catch {
    /* pruning is best-effort — never break a navigation over it */
  }
}

/** Store the shell copy that later navigations may be served from. A
 *  redirected response must be re-wrapped first: the spec forbids answering a
 *  navigation with a cached response whose `redirected` flag is set, so an
 *  un-wrapped copy would reject the very offline boot it exists for ("a
 *  redirected response was used for a request whose redirect mode is not
 *  'follow'"). Subresource caches (assets, SDK) are unaffected — their
 *  requests follow redirects. */
async function putShellCopy(cache, fresh) {
  try {
    if (!fresh.redirected) {
      await cache.put('./index.html', fresh.clone());
      return;
    }
    const body = await fresh.clone().blob();
    await cache.put('./index.html', new Response(body, { status: 200, headers: fresh.headers }));
  } catch {
    /* best-effort — never break a navigation over the cache copy */
  }
}

async function networkFirstNavigation(event, request) {
  const cache = await caches.open(CACHE);
  // Only a navigation to the app shell itself may refresh the './index.html'
  // fallback. Caching any successful navigation here would let a standalone
  // page (e.g. /rsvp.html, the RSVP confirmation) overwrite the shell — the
  // next offline boot would then open on the wrong page. Shell-ness is
  // derived from the registration scope (not a '/' literal) so a subpath
  // deployment keeps its offline boot.
  const path = new URL(request.url).pathname;
  const scopePath = new URL(self.registration.scope).pathname;
  const isShell = path === scopePath || path.endsWith('/index.html');
  try {
    const fresh = await fetch(request);
    // waitUntil: once the response is handed back the browser may stop this
    // worker, aborting an un-anchored put mid-write. Pruning runs after the
    // put so it reads the shell this navigation will actually boot from.
    if (fresh && fresh.ok && isShell)
      event.waitUntil(putShellCopy(cache, fresh).then(() => pruneStaleAssets(cache)));
    return fresh;
  } catch {
    if (!isShell) return Response.error(); // standalone pages need the network anyway
    return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
  }
}

async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((resp) => {
      if (isCacheableAsset(resp)) return cache.put(request, resp.clone()).then(() => resp);
      return resp;
    })
    .catch(() => null);
  if (cached) {
    // Serve instantly, but keep the worker alive until the background refresh
    // lands — otherwise the browser may terminate it right after respondWith
    // settles and the revalidation is sporadically thrown away, letting a
    // stale non-hashed asset (manifest, icon) persist indefinitely.
    event.waitUntil(network);
    return cached;
  }
  return (await network) || Response.error();
}

async function networkFirstSdk(event, request) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    // Opaque (no-cors) responses have status 0; cache them so an offline cold
    // start can still load the SDK. But do NOT cache a visible error (e.g. a
    // transient 5xx from the CDN) — that would be served on a later offline
    // start and make the SDK "fail" until the next online load overwrites it.
    if (fresh.ok || fresh.type === 'opaque') event.waitUntil(cache.put(request, fresh.clone()));
    return fresh;
  } catch {
    return (await cache.match(request)) || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never intercept non-GET (writes/API) — straight to network, never cached.
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  const isSdk = url.origin === SDK_ORIGIN;

  // Ignore all other cross-origin requests (api.puter.com, telemetry, …).
  if (!sameOrigin && !isSdk) return;

  // Wrap every path so a handler bug can never block a request: on any
  // unexpected error we fall through to the plain network fetch.
  event.respondWith(
    (async () => {
      try {
        if (request.mode === 'navigate') return await networkFirstNavigation(event, request);
        if (isSdk) return await networkFirstSdk(event, request);
        return await staleWhileRevalidate(event, request);
      } catch {
        return fetch(request);
      }
    })(),
  );
});
