// Browser notifications for reminders while Trips is open. Permission is asked only from a user action (a switch or a
// reminder's "Turn on" button); the on/off choice is per device, since permission is per browser.
import { locale } from '../i18n/index.js';

const KEY = 'trips:notify';
const listeners = new Set();

function read() { try { return JSON.parse(globalThis.localStorage?.getItem(KEY) ?? 'null') ?? {}; } catch { return {}; } }
function write(value) {
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(value)); } catch { /* per-device convenience only */ }
  for (const listener of [...listeners]) { try { listener(); } catch { /* keep notifying */ } }
}
const api = (win) => (typeof win?.Notification === 'function' ? win.Notification : null);

/** `unsupported`, `default`, `granted` or `denied`. */
export function permission(win = globalThis.window) {
  const N = api(win);
  return N ? N.permission ?? 'default' : 'unsupported';
}
/** On when the user turned browser notifications on here and the browser still allows them. */
export const browserNotifications = (win = globalThis.window) => read().browser === true && permission(win) === 'granted';
export const browserChoice = () => read().browser === true;
/** Whether the in-app offer to turn them on was already dismissed. */
export const offerDismissed = () => read().offer === 'dismissed';
export function dismissOffer() { write({ ...read(), offer: 'dismissed' }); }
export function onBrowserChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }

/** Turns browser notifications on (asking for permission, so call it from a click) or off. Resolves the new state. */
export async function setBrowserNotifications(on, win = globalThis.window) {
  if (!on) { write({ ...read(), browser: false }); return false; }
  const N = api(win);
  if (!N) return false;
  let state = N.permission;
  if (state === 'default') {
    try { state = await N.requestPermission(); } catch { state = N.permission; }
  }
  write({ ...read(), browser: state === 'granted', offer: 'dismissed' });
  return state === 'granted';
}

/**
 * Shows one notification. `tag` replaces an earlier one with the same tag (the same reminder from another tab).
 * Falls back to the service worker where the constructor is not allowed (Android). Resolves true when shown.
 */
export async function showNotification({ title, body, tag, onClick }, win = globalThis.window) {
  const N = api(win);
  if (!N || N.permission !== 'granted') return false;
  const icon = new URL('icons/icon-192.png', win.document?.baseURI ?? win.location?.href).href;
  try {
    const note = new N(title, { body, tag, icon, lang: locale });
    note.onclick = () => { try { win.focus(); } catch { /* not allowed */ } note.close(); onClick?.(); };
    return true;
  } catch {
    try {
      const registration = await win.navigator?.serviceWorker?.getRegistration?.();
      if (!registration?.showNotification) return false;
      await registration.showNotification(title, { body, tag, icon });
      return true;
    } catch { return false; }
  }
}
