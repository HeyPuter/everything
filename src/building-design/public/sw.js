/*
 * Offline app shell. Projects never pass through here: they live in the
 * user's files and in the app's own IndexedDB recovery store.
 *
 *   page loads        network first, cached copy when offline
 *   /assets/ files    cache first (build file names carry content hashes)
 *   other own files   cached copy right away, refreshed in the background
 *   cross-origin      untouched (Puter's SDK and API)
 */
const CACHE = 'building-design-shell-v1';
const SHELL = ['./', './index.html', './manifest.json', './icons/icon-32.png', './icons/icon-192.png'];

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
  event.waitUntil(
    Promise.all(
      urls.map((u) =>
        fetch(u)
          .then((res) => putAsset(u, res))
          .catch(() => {}),
      ),
    ),
  );
});

/** Build files are named chunk-hash.ext: keep only the newest of each chunk. */
function chunkKey(url) {
  const m = /\/assets\/(.+)-[\w-]{6,}\.(\w+)$/.exec(new URL(url).pathname);
  return m ? `${m[1]}.${m[2]}` : null;
}

async function putAsset(url, res) {
  if (!res || !res.ok) return;
  const c = await caches.open(CACHE);
  const key = chunkKey(url);
  if (key) for (const old of await c.keys()) if (old.url !== url && chunkKey(old.url) === key) await c.delete(old);
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

  if (url.pathname.includes('/assets/')) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => store(req, res))));
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      const fresh = fetch(req)
        .then((res) => store(req, res))
        .catch(() => hit);
      return hit || fresh;
    }),
  );
});
