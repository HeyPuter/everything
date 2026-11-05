/**
 * The installable app: service worker registration with an update prompt,
 * Puter pushes, the install prompt, and the iOS hint.
 * All of it is optional: nothing here runs in the dev harness, and every
 * capability is probed before use.
 */
import { api } from './api.js';

let registration = null;
let deferredInstall = null;
let refreshing = false;

export const swSupported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
export const pushSupported = () => swSupported() && typeof PushManager !== 'undefined' && typeof Notification !== 'undefined';
export const isStandalone = () => (typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.MSStream;

/**
 * Register sw.js (built next to the app) and report a waiting update. The
 * page reloads once the new worker takes over, and only when the user asked.
 */
export async function registerServiceWorker({ onUpdate, onMessage, onRoute } = {}) {
  if (!swSupported() || !import.meta.env?.PROD) return null;
  // Whether a worker controls this page: the first worker to claim it is
  // not an update, and must not reload a page mid-sign-in. A page that
  // started uncontrolled (a first visit) is controlled from that claim on,
  // so an update that lands later in the tab's life reloads it like any
  // other; and a reload the user asked for happens whatever the page's
  // history, since the new worker drops the old build's cache as it takes
  // over and the old page's lazy chunks are then gone.
  let controlled = !!navigator.serviceWorker.controller;
  let asked = false;
  try {
    registration = await navigator.serviceWorker.register('./sw.js');
  } catch (e) {
    console.warn('Service worker registration failed', e);
    return null;
  }
  const apply = (worker) => () => {
    asked = true;
    worker.postMessage({ type: 'SKIP_WAITING' });
  };
  const watch = (worker) => {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) onUpdate?.(apply(worker));
    });
  };
  if (registration.waiting && navigator.serviceWorker.controller) onUpdate?.(apply(registration.waiting));
  watch(registration.installing);
  registration.addEventListener('updatefound', () => watch(registration.installing));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!controlled && !asked) {
      controlled = true;
      return;
    }
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });
  navigator.serviceWorker.addEventListener('message', (e) => {
    // The push handler asking which workspace this window shows, answered
    // over the port it sent; it waits briefly, so an answer that cannot be
    // had (no onRoute, a throw) is given as null rather than never.
    if (e.data?.type === 'route?' && e.ports?.[0]) {
      let route = null;
      try {
        route = onRoute?.() || null;
      } catch { /* answered as null */ }
      e.ports[0].postMessage(route);
      return;
    }
    onMessage?.(e.data);
  });
  // Look for a new build whenever the tab comes back.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) registration.update().catch(() => {}); });
  return registration;
}

export function captureInstallPrompt(onAvailable) {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    onAvailable?.();
  });
  window.addEventListener('appinstalled', () => { deferredInstall = null; onAvailable?.(); });
}

export const canInstall = () => !!deferredInstall && !isStandalone();

export async function promptInstall() {
  if (!deferredInstall) return false;
  const e = deferredInstall;
  deferredInstall = null;
  e.prompt();
  const choice = await e.userChoice.catch(() => null);
  return choice?.outcome === 'accepted';
}

/* ---- push --------------------------------------------------------------- */

/** Workspace workers notify members through their KV shares; Puter delivers the pushes. */

/** The worker Puter's push script runs in: this app's own. */
const swPath = () => new URL('./sw.js', document.baseURI).pathname;

/** Set once Puter's push holds this origin's subscription, so an older one is told apart from it. */
const PUTER_PUSH_KEY = 'tc:puter-push';

/**
 * What a push shows: the notification as sent, under the tag the page's own
 * banner for the same news wears, so one replaces the other. Re-created in
 * the worker from its source, so it uses nothing from around it.
 */
const showPush = async (n) => {
  const d = n.data || {};
  // In the service worker with no window open, nothing else marks the icon:
  // a dot says there is news, and the first page to open sets the number.
  if (typeof window === 'undefined' && !(await self.clients.matchAll({ type: 'window' })).length) {
    await self.navigator.setAppBadge?.().catch(() => {});
  }
  // A call stays up until it's answered or dismissed.
  return { ...(d.g ? { tag: d.g } : {}), ...(d.c ? { requireInteraction: true } : {}), url: n.target || '/' };
};

/**
 * Dismiss the Puter notifications this browser shows under any of `tags`,
 * which closes them on the user's other devices too.
 */
export async function dismissShown(tags) {
  if (!swSupported() || typeof puter === 'undefined') return;
  const reg = registration || (await navigator.serviceWorker.getRegistration(swPath()).catch(() => null));
  for (const shown of (await reg?.getNotifications().catch(() => null)) || []) {
    const uid = shown.data?.puter?.uid;
    if (uid && tags.has(shown.tag)) puter.notifications.dismiss(uid).catch(() => {});
  }
}

let pushListener = null;

/**
 * Take this app's notifications in the page and keep this browser's push
 * registration current, once pushes were enabled here. On every load.
 */
export function listenForPushes() {
  if (pushListener || typeof puter === 'undefined' || typeof puter.notifications?.onPush !== 'function') return pushListener;
  pushListener = puter.notifications.onPush('chat', showPush, {
    serviceWorker: swPath(),
    onError: (err) => console.warn('Teamchat push', err),
  }).catch(() => {
    pushListener = null;
    return null;
  });
  return pushListener;
}

/** Stop taking pushes in this page; Puter drops the saved handler once no tab uses it. */
export async function stopListeningForPushes() {
  const listener = await pushListener;
  pushListener = null;
  await listener?.off?.();
}

/**
 * Turn Puter pushes on in this browser; resolves whether it now receives
 * them. On a website this puts up the browser's own prompt, which needs the
 * click, so a caller makes it the first thing the click does, with no await
 * before it. Inside the Puter desktop Puter turns them on itself, for an app
 * asking with its own permission dialog. `retire` lets go of a subscription
 * made the old way, which holds the origin's one push subscription.
 */
export async function enablePuterPush(retire) {
  const n = puter.notifications;
  if (puter.env !== 'web') {
    await retire?.();
    return n.enable();
  }
  const opts = { serviceWorker: swPath() };
  let on;
  try {
    on = await n.enable(opts);
  } catch (err) {
    if (err?.code === 'push_subscription_conflict' && retire) {
      await retire();
      on = await n.enable(opts);
    } else if (err?.code === 'push_revoked') {
      // The app was turned off in Puter's settings; its own prompt undoes that.
      on = (await n.requestPermission()) && (await n.enable(opts));
    } else {
      throw err;
    }
  }
  if (on) {
    try {
      localStorage.setItem(PUTER_PUSH_KEY, '1');
    } catch { /* told apart by a conflict instead */ }
  }
  return !!on;
}

/** Read the same browser registration that enable() uses. */
export async function puterPushStatus() {
  if (typeof puter === 'undefined' || typeof puter.notifications?.status !== 'function') return 'unavailable';
  return puter.notifications.status({ serviceWorker: swPath() });
}

/** Turn pushes off in this browser, or revoke the app's push grant on the desktop. */
export async function disablePuterPush() {
  if (typeof puter === 'undefined') return;
  await puter.notifications.disable({ serviceWorker: swPath() }).catch(() => {});
}

/**
 * A subscription this device made before pushes went through Puter, when it
 * holds one. Inside the desktop any subscription of this app's worker is one
 * (Puter's live with Puter); on a website, one made before Puter's took over.
 */
async function legacySubscription() {
  if (!pushSupported()) return null;
  if (typeof puter !== 'undefined' && puter.env === 'web') {
    try {
      if (localStorage.getItem(PUTER_PUSH_KEY)) return null;
    } catch { /* unreadable: looked at below */ }
  }
  const reg = registration || (await navigator.serviceWorker.getRegistration().catch(() => null));
  return (await reg?.pushManager?.getSubscription().catch(() => null)) || null;
}

/**
 * Let go of a subscription made the old way: each workspace's worker is told
 * to forget it (briefly; one not told drops it at its next push, which the
 * push service refuses), then the browser.
 */
export async function retireLegacyPush(refs, waitMs = 4000) {
  const sub = await legacySubscription();
  if (!sub) return;
  await Promise.race([
    Promise.allSettled(refs.map((ref) => api.pushUnsubscribe(ref, sub.endpoint))),
    new Promise((r) => setTimeout(r, waitMs)),
  ]);
  await sub.unsubscribe().catch(() => {});
}

/** The device's offset from UTC in minutes, as the workers are told it (see pushPrefs). */
export const localTzOffset = () => -new Date().getTimezoneOffset();
/** The offset the workers were last told (see notePushOffset); null until one was. */
let sentTzOffset = null;

/** What the worker needs to respect quiet hours and pauses while the app is closed. */
export function pushPrefs(prefs = {}) {
  const minutes = (hm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const d = prefs.dnd || {};
  return {
    pauseUntil: prefs.pauseUntil || null,
    tzOffset: localTzOffset(),
    dnd: d.enabled && minutes(d.from) != null && minutes(d.to) != null ? { enabled: true, from: minutes(d.from), to: minutes(d.to) } : { enabled: false },
  };
}

/**
 * Has the device's clock moved to another offset from UTC since the workers
 * were last told it (the clocks changed for daylight saving, the device
 * travelled)? The workers keep quiet hours by the offset they were told,
 * since they cannot know the zone, so after the clocks change pushes kept
 * the old hour's quiet hours until the app was next opened. The store asks
 * this on every poll and tells them again (see syncPushPrefs). Nothing has
 * moved while nothing was told.
 */
export function pushOffsetMoved() {
  return sentTzOffset !== null && sentTzOffset !== localTzOffset();
}

/** The offset just sent to the workers (null: none is kept up any more). */
export function _notePushOffset(tz) {
  sentTzOffset = tz;
}
