import { toast } from '../../ui/toast.js';
import { t } from '../i18n/index.js';

// Device setting, read before the shell starts so the whole app boots offline.
const FORCE_KEY = 'trips:forceOffline';
const CHECK_EVERY = 60 * 60_000;
const listeners = new Set();
let forced = null;

function readForced(target) {
  try { return target.localStorage.getItem(FORCE_KEY) === '1'; } catch { return false; }
}
export function isForcedOffline(target = globalThis.window) {
  forced ??= target ? readForced(target) : false;
  return forced;
}
/** Online as far as the app is concerned: the browser is connected and "Work offline" is off. */
export const appOnline = (target = globalThis.window) => !isForcedOffline(target) && target?.navigator?.onLine !== false;
export function onForcedOffline(listener) { listeners.add(listener); return () => listeners.delete(listener); }

// While forced, `navigator.onLine` reads false so every module takes its offline path; the service worker refuses
// network requests that would sync data.
function applyOnline(target, offline) {
  const nav = target.navigator;
  if (!nav) return;
  if (offline) Object.defineProperty(nav, 'onLine', { configurable: true, get: () => false });
  else if (Object.hasOwn(nav, 'onLine')) delete nav.onLine;
}
function tellWorker(target, on) {
  try { target.navigator.serviceWorker?.controller?.postMessage({ type: 'trips:force-offline', on }); } catch { /* No worker. */ }
}

/** Turns "Work offline" on or off for this device and tells the app as if the connection changed. */
export function setForcedOffline(on, { window: target = globalThis.window, username } = {}) {
  const value = Boolean(on);
  try { if (value) target.localStorage.setItem(FORCE_KEY, '1'); else target.localStorage.removeItem(FORCE_KEY); } catch { /* Session only. */ }
  if (value === isForcedOffline(target)) return;
  forced = value;
  applyOnline(target, value);
  tellWorker(target, value);
  // mock.html test hook: the fake runtime ignores the network, so take its user offline too.
  const world = globalThis.__TRIPS_MOCK__;
  if (typeof world?.setOffline === 'function' && username) { try { world.setOffline(username, value); } catch { /* Not a mock user. */ } }
  announce(target, value);
}
function announce(target, value) {
  target.dispatchEvent(new target.Event(value ? 'offline' : 'online'));
  for (const listener of listeners) listener(value);
}

function enabled(target) {
  if (!import.meta.env?.PROD || !target.navigator?.serviceWorker) return false;
  // The mock build registers the worker only with `?sw=1`, so browser tests keep fresh builds by default.
  return import.meta.env.MODE !== 'mock' || new URLSearchParams(target.location.search).has('sw');
}

/**
 * Applies "Work offline", registers sw.js and offers "New version ready — Reload". The page reloads only when the user
 * asks; a worker another tab activated keeps the previous build's files, so this tab keeps working until it reloads.
 */
export async function startPwa({ window: target = globalThis.window, notify = toast } = {}) {
  if (!target) return null;
  if (isForcedOffline(target)) applyOnline(target, true);
  // Another tab switched "Work offline".
  target.addEventListener('storage', (event) => {
    if (event.key !== FORCE_KEY) return;
    const value = event.newValue === '1';
    if (value === isForcedOffline(target)) return;
    forced = value; applyOnline(target, value); announce(target, value);
  });
  if (!enabled(target)) return null;
  const container = target.navigator.serviceWorker;
  let controlled = Boolean(container.controller);
  let asked = false;
  let reloading = false;
  let shown = null;
  let registration;
  try {
    registration = await container.register(new URL('sw.js', target.document.baseURI).href, { scope: './' });
  } catch { return null; }
  const offer = (worker) => {
    shown?.close();
    shown = notify(t('offline.updateReady'), { duration: 0, action: { label: t('offline.reload'), onClick: () => {
      asked = true;
      if (worker && worker.state !== 'activated' && worker.state !== 'redundant') worker.postMessage({ type: 'trips:skip-waiting' });
      else { reloading = true; target.location.reload(); }
    } } });
  };
  const watch = (worker) => {
    worker?.addEventListener('statechange', () => { if (worker.state === 'installed' && container.controller) offer(worker); });
  };
  if (registration.waiting && container.controller) offer(registration.waiting);
  watch(registration.installing);
  registration.addEventListener('updatefound', () => watch(registration.installing));
  container.addEventListener('controllerchange', () => {
    tellWorker(target, isForcedOffline(target));
    // The first worker to claim a fresh page is not an update.
    if (!controlled) { controlled = true; return; }
    if (reloading) return;
    if (asked) { reloading = true; target.location.reload(); return; }
    offer(null);
  });
  tellWorker(target, isForcedOffline(target));
  const check = () => { void registration.update().catch(() => {}); };
  target.document.addEventListener('visibilitychange', () => { if (!target.document.hidden) check(); });
  target.setInterval(check, CHECK_EVERY);
  return registration;
}
