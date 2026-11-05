/* Teamchat service worker. Built into dist/sw.js by vite.config.js, which
   fills in the version and the asset list from the build. */
const VERSION = __SW_VERSION__;
const ASSETS = __SW_ASSETS__;
const SHELL = `teamchat-shell-${VERSION}`;
const EXT = 'teamchat-ext';

// Puter's push handling: shows Puter pushes and routes their taps. Only
// listens, and only to pushes Puter sent; a blocked load must not cost the
// offline shell, so it is allowed to fail.
try {
  importScripts('https://js.puter.com/push-sw.js');
} catch {
  /* pushes through Puter are unavailable on this device */
}
const fromPuter = (data) => !!(data && (data.puter || data.data?.puter));
/** How long a navigation waits on the network for the SDK before the cached copy is used. */
const SDK_WAIT_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await Promise.all(ASSETS.map((a) => cache.add(new Request(a, { cache: 'reload' })).catch(() => {})));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('teamchat-shell-') && key !== SHELL) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

/**
 * Navigations: the network first, so a new deployment shows up, and the
 * cached shell when offline. Hashed assets: cache first (their names change
 * with their content). The Puter SDK: network first, the cached copy so the app can
 * boot offline. API traffic goes through puter.workers.exec and is not
 * touched here.
 */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        // Only a good page becomes the offline shell: a maintenance page or
        // a 5xx from the host must not replace the working one, nor may a
        // file opened by its address (the worker bundle, the manifest, an
        // icon), which is a navigation too.
        if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
          const cache = await caches.open(SHELL);
          cache.put('./index.html', res.clone()).catch(() => {});
        }
        return res;
      } catch {
        return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok && url.pathname.includes('/assets/')) (await caches.open(SHELL)).put(req, res.clone()).catch(() => {});
        return res;
      } catch {
        return Response.error();
      }
    })());
    return;
  }
  if (url.hostname === 'js.puter.com') {
    event.respondWith((async () => {
      const cache = await caches.open(EXT);
      // The network first: a page running an SDK older than Puter's pushes
      // holds every push back while it is open, so the cached copy is only
      // for booting offline, or past a few seconds' wait. The SDK is a plain
      // cross-origin script tag, so its response is opaque (status 0, ok
      // false); it is still the script.
      const net = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()).catch(() => {}); return res; }).catch(() => null);
      const res = await Promise.race([net, new Promise((r) => setTimeout(() => r(null), SDK_WAIT_MS))]);
      return res || (await cache.match(req)) || (await net) || Response.error();
    })());
  }
});

/* ---- push ---------------------------------------------------------------- */

/**
 * Is the user looking at the workspace this push is about? A focused,
 * visible window is asked which workspace its hash names (the page answers
 * through pwa.js); on that workspace the page itself already tells the user
 * what deserves telling — badges and bold rows on screen, the chime for a
 * conversation other than the open one — so a banner on top would announce
 * what they are looking at. A window that does not answer in time, or one
 * on another workspace (which the page does not poll), keeps the banner.
 */
async function viewing(all, ws) {
  if (!ws) return false;
  const focused = all.filter((c) => c.focused && c.visibilityState === 'visible');
  if (!focused.length) return false;
  const answers = await Promise.all(focused.map((client) => new Promise((resolve) => {
    const mc = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 400);
    mc.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data);
    };
    try {
      client.postMessage({ type: 'route?' }, [mc.port2]);
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  })));
  return answers.some((a) => a && a.ws === ws);
}

/**
 * The name the notification is shown under: the push's own tag, which a
 * current worker names with the workspace as the page names its banners
 * (`ref:kind-conversation`, see shell.js maybeNotify and the worker's
 * sendPushes), so that the browser shows the later of the page's banner and
 * the push in place of the first. A worker not yet redeployed names its
 * pushes without the workspace (`kind-conversation`, the page's old name),
 * and beside a banner of the page's a phone with the app in the background
 * showed the news twice; its push carries the same deep link a current one
 * does, which names the workspace as the page refers to it, so the page's
 * name is made from the two. A push with no link to read it from keeps the
 * tag it came with.
 */
function pageTag(data) {
  const tag = typeof data.tag === 'string' && data.tag ? data.tag : 'teamchat';
  if (tag.includes(':') || tag === 'teamchat') return tag;
  const m = /^#\/ws\/([^/]+)/.exec(String(data.route || ''));
  if (!m) return tag;
  let ref = m[1];
  try {
    ref = decodeURIComponent(ref);
  } catch {
    /* as written */
  }
  return `${ref}:${tag}`;
}

/** Pushes signed by a workspace's own worker, from devices subscribed before pushes went through Puter. */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Teamchat', body: event.data?.text() || '' };
  }
  if (fromPuter(data)) return;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true }).catch(() => []);
    if (await viewing(all, data.ws).catch(() => false)) return;
    // With no window of the app open, nothing else can mark the installed
    // icon: a dot on it says there is news (the payload carries no count,
    // and this worker has none to add up), and the first page to open
    // replaces it with the exact number or clears it (see updateTitle in
    // shell.js). With a window open, even a hidden one, that page keeps
    // the number itself.
    if (!all.length) await self.navigator.setAppBadge?.().catch(() => {});
    await self.registration.showNotification(data.title || 'Teamchat', {
      body: data.body || '',
      tag: pageTag(data),
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      data: { route: data.route || '#/' },
      renotify: false,
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  if (event.notification.data?.puter) return;
  event.notification.close();
  const route = event.notification.data?.route || '#/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all.find((c) => c.url.startsWith(self.registration.scope));
    if (client) {
      // Bringing the window up may be refused (the browser's rules on who
      // may bring a window up, and when), or the window may have closed
      // between the listing and now. The page is told where to go all the
      // same while it stands (it navigates whether or not it came to the
      // front), and a new window is opened when it is gone. Left to fail,
      // the refusal ended the tap here, and nothing happened.
      const focused = await client.focus().then(() => true, () => false);
      const standing = focused || (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }).catch(() => [])).some((c) => c.id === client.id);
      if (standing) {
        client.postMessage({ type: 'navigate', route });
        return;
      }
    }
    await self.clients.openWindow(new URL(`./${route}`, self.registration.scope).toString());
  })());
});
