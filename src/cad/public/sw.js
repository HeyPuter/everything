/*
 * Offline app shell. Drawings never pass through here: they live in the
 * user's files and in the app's own IndexedDB recovery store.
 *
 *   page loads        network first, cached copy when offline
 *   /assets/ files    cache first (build file names carry content hashes)
 *   other own files   cached copy right away, refreshed in the background
 *   cross-origin      untouched (Puter's SDK and API)
 */
const CACHE = 'cad-shell-v1';
const SHELL = ['./', './index.html', './manifest.json', './favicon.ico', './icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {})
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

/*
 * The page sends the build files it loaded (they were fetched before this
 * worker controlled the page). Cache them so the app opens offline after
 * one visit, and drop build files from earlier versions.
 */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'precache' || !Array.isArray(data.urls)) return;
  const urls = data.urls.filter((u) => {
    try {
      return new URL(u).origin === self.location.origin;
    } catch {
      return false;
    }
  });
  const seen = new Set();
  event.waitUntil(Promise.all(urls.map((u) => precache(u, seen))));
});

/*
 * Cache a build file and the build files its code loads later (workers and
 * lazy chunks, referenced by name next to it), so DXF and DWG work offline
 * without having been used online first.
 */
async function precache(url, seen) {
  if (seen.has(url)) return;
  seen.add(url);
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    const js = /\.js$/.test(new URL(url).pathname);
    const later = js ? siblings(url, await res.clone().text()) : [];
    await putAsset(url, res);
    await Promise.all(later.map((u) => precache(u, seen)));
  } catch {
    /* offline or gone: cached on first use instead */
  }
}

function siblings(url, code) {
  const out = [];
  for (const m of code.matchAll(/["'`]([\w.-]+-[\w-]{8}\.(?:js|css|wasm))["'`]/g)) {
    const u = new URL(m[1], url).href;
    if (u.includes('/assets/') && u !== url) out.push(u);
  }
  return out;
}

/**
 * Build files are named chunk-hash.ext: keep only the newest of each chunk.
 * Hashes are exactly 8 characters and may contain '-' (index-B-9aQzzz.js).
 * While a second tab is open the earlier ones stay: that tab may run the
 * earlier build and load its worker and lazy chunks later.
 */
function chunkKey(url) {
  const m = /\/assets\/(.+)-[\w-]{8}\.(\w+)$/.exec(new URL(url).pathname);
  return m ? `${m[1]}.${m[2]}` : null;
}

async function onlyTab() {
  try {
    return (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).length <= 1;
  } catch {
    return true;
  }
}

async function putAsset(url, res) {
  if (!res || !res.ok) return;
  const c = await caches.open(CACHE);
  const key = chunkKey(url);
  if (key && (await onlyTab())) for (const old of await c.keys()) if (old.url !== url && chunkKey(old.url) === key) await c.delete(old);
  await c.put(url, res);
}

function store(req, res) {
  if (res && res.ok) {
    const copy = res.clone();
    if (new URL(req.url).pathname.includes('/assets/')) putAsset(req.url, copy);
    else caches.open(CACHE).then((c) => c.put(req, copy));
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && /text\/html/i.test(res.headers.get('content-type') || '')) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html')),
    );
    return;
  }

  // The app's own files are the same for every request. A host that answers
  // with "Vary: Origin" must not make the cached copy miss: the page asks for
  // its script and style sheet with an Origin header (they are crossorigin),
  // while the copies were fetched here without one.
  if (url.pathname.includes('/assets/')) {
    event.respondWith(caches.match(req, { ignoreVary: true }).then((hit) => hit || fetch(req).then((res) => store(req, res))));
    return;
  }

  event.respondWith(
    caches.match(req, { ignoreVary: true }).then((hit) => {
      const fresh = fetch(req)
        .then((res) => store(req, res))
        .catch(() => hit);
      return hit || fresh;
    }),
  );
});
