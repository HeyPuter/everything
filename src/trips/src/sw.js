/* Trips service worker. tools/vite-pwa.mjs fills in the build version and the precache list at build time.
 * Never cached: worker traffic (*.puter.work), Puter API calls, /config.json, the worker bundle and the Puter SDK. */
const VERSION = __SW_VERSION__;
const ASSETS = __SW_ASSETS__;
const SHELL = `trips-shell-${VERSION}`;
const SHELL_PREFIX = 'trips-shell-';
const DATA = 'trips-data-v1';
const MAP = 'trips-map-v1';
const STATE = 'trips-sw-state';
const TILE_HOST = 'tiles.openfreemap.org';
const SDK_HOST = 'js.puter.com';
const NETWORK_WAIT = 4000;

const scope = new URL(self.registration.scope);
const stateURL = new URL('__trips-sw/force-offline', scope).href;
let forced = null;
const forcedReady = caches.open(STATE).then((cache) => cache.match(stateURL)).then((response) => (response ? response.text() : '0'))
  .then((value) => { forced ??= value === '1'; }, () => { forced ??= false; });

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(ASSETS.map((path) => new Request(new URL(path, scope), { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // The newest earlier build stays, so tabs still running it can load their lazy chunks until they reload.
    const older = (await caches.keys()).filter((name) => name.startsWith(SHELL_PREFIX) && name !== SHELL);
    await Promise.all(older.slice(0, -1).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const type = event.data?.type;
  if (type === 'trips:skip-waiting') self.skipWaiting();
  else if (type === 'trips:force-offline') {
    forced = event.data.on === true;
    event.waitUntil(caches.open(STATE).then((cache) => cache.put(stateURL, new Response(forced ? '1' : '0'))));
  }
});

/**
 * `pass`: left to the browser. `network`: sync and provider traffic, refused while "Work offline" is on.
 * The rest are served from caches: `navigate`, `asset`, `static`, `data`, `tile`, `map-json`, `map-static`.
 */
function classify(url, request) {
  if (url.origin === scope.origin) {
    const path = url.pathname.startsWith(scope.pathname) ? url.pathname.slice(scope.pathname.length) : url.pathname.slice(1);
    if (url.pathname.endsWith('/config.json') || path === 'sw.js' || path.startsWith('worker/') || url.pathname.includes('/worker/')) return 'pass';
    if (request.method !== 'GET') return 'pass';
    if (request.mode === 'navigate') return 'navigate';
    if (path.startsWith('assets/')) return 'asset';
    if (path.startsWith('data/') || url.pathname.startsWith('/data/')) return 'data';
    if (path.startsWith('__trips-sw/') || path.startsWith('offline-files/')) return 'pass';
    return 'static';
  }
  if (url.protocol !== 'https:') return 'pass';
  const host = url.hostname;
  if (host === SDK_HOST) return 'pass';
  if (host === TILE_HOST) {
    if (request.method !== 'GET') return 'network';
    if (/\/\d+\/\d+\/\d+\.[a-z]+$/.test(url.pathname)) return 'tile';
    if (url.pathname.startsWith('/sprites/') || url.pathname.startsWith('/fonts/')) return 'map-static';
    return 'map-json';
  }
  if (host.endsWith('.puter.work')) return 'network';
  if (host === 'api.puter.com') return url.pathname === '/whoami' ? 'pass' : 'network';
  if (host === 'puter.com' || host.endsWith('.puter.com') || host.endsWith('.puter.site')) return 'pass';
  return 'network';
}

const refused = () => Response.error();
const usable = (response) => response && response.ok && (response.type === 'basic' || response.type === 'cors' || response.type === 'default');

function within(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })]).finally(() => clearTimeout(timer));
}
async function put(name, request, response) {
  try { await (await caches.open(name)).put(request, response); } catch { /* Quota or an uncacheable response. */ }
}
async function fromCache(name, request, options) {
  const cache = await caches.open(name);
  return cache.match(request, options);
}

async function navigate(request) {
  const network = fetch(request);
  network.catch(() => {});
  try {
    const response = await within(network, NETWORK_WAIT);
    if (response.status < 500) return response;
  } catch { /* Offline or slow: use the cached shell. */ }
  const cached = await caches.match(request, { ignoreSearch: true }) ?? await caches.match(new URL('index.html', scope).href) ?? await caches.match(scope.href);
  return cached ?? network;
}
async function asset(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (usable(response)) await put(SHELL, request, response.clone());
  return response;
}
async function revalidate(name, request, event) {
  const cached = await caches.match(request);
  const update = fetch(request).then(async (response) => { if (usable(response)) await put(name, request, response.clone()); return response; });
  if (cached) { event.waitUntil(update.catch(() => {})); return cached; }
  return update;
}
async function tile(request, offline) {
  const cached = await fromCache(MAP, request, { ignoreVary: true, ignoreSearch: false });
  if (cached || offline) return cached ?? refused();
  return fetch(request);
}
async function mapJSON(request, offline) {
  if (!offline) {
    try { const response = await within(fetch(request), NETWORK_WAIT); if (response.ok) return response; } catch { /* Fall back to the copy kept for offline maps. */ }
  }
  return (await fromCache(MAP, request, { ignoreVary: true })) ?? (offline ? refused() : fetch(request));
}
async function mapStatic(request, offline) {
  const cached = await fromCache(MAP, request, { ignoreVary: true });
  if (cached || offline) return cached ?? refused();
  const response = await fetch(request);
  if (usable(response)) await put(MAP, request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  let url;
  try { url = new URL(request.url); } catch { return; }
  const kind = classify(url, request);
  if (kind === 'pass') return;
  if (kind === 'network') {
    if (forced === false) return;
    event.respondWith(forcedReady.then(() => (forced ? refused() : fetch(request))));
    return;
  }
  const offline = () => forcedReady.then(() => forced === true);
  if (kind === 'navigate') event.respondWith(navigate(request));
  else if (kind === 'asset') event.respondWith(asset(request));
  else if (kind === 'static') event.respondWith(revalidate(SHELL, request, event));
  else if (kind === 'data') event.respondWith(revalidate(DATA, request, event));
  else if (kind === 'tile') event.respondWith(offline().then((value) => tile(request, value)));
  else if (kind === 'map-json') event.respondWith(offline().then((value) => mapJSON(request, value)));
  else if (kind === 'map-static') event.respondWith(offline().then((value) => mapStatic(request, value)));
});
