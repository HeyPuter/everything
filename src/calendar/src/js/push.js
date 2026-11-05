/**
 * Push notifications through `puter.notifications`. The senders live outside
 * the page: the mail handler (invitations, updates, cancellations, replies to
 * the user's events) and the host's RSVP worker (guest answers), both on the
 * `calendar` channel. This module registers the channel's push handler, hands
 * clicked notifications to the app, and backs the settings switch. Stored
 * reminders (stored-reminders.js) use this channel too.
 */

export const PUSH_CHANNEL = 'calendar';
/** public/sw.js, which imports push-sw.js. Relative, like its registration. */
export const SERVICE_WORKER = './sw.js';
export const PUSH_OPTIONS = Object.freeze({ serviceWorker: SERVICE_WORKER });

// Set when the user turns pushes off here, so connecting the mailbox later
// doesn't quietly turn them back on.
const OFF_KEY = 'cal:push-off';

let started = false;
let route = null;
let pendingClick = null;

function sdk() {
  return typeof puter !== 'undefined' ? puter : null;
}

export function pushOffHere() {
  try {
    return localStorage.getItem(OFF_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberOff(off) {
  try {
    if (off) localStorage.setItem(OFF_KEY, '1');
    else localStorage.removeItem(OFF_KEY);
  } catch {
    /* blocked storage: only the mailbox connect flow reads this */
  }
}

/** iPhone/iPad Safari outside a Home Screen app, where pushes can't arrive. */
export function needsHomeScreen(nav = navigator, win = window) {
  const ios = /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  if (!ios) return false;
  const standalone = nav.standalone === true || (win.matchMedia && win.matchMedia('(display-mode: standalone)').matches);
  return !standalone;
}

/** Whether this page can offer the switch at all. */
export function pushAvailable(p = sdk()) {
  if (!p || !p.notifications) return false;
  if (p.env === 'app') return true;
  return (
    p.env === 'web' &&
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * Once per page load, before sign-in finishes: the click that launched the
 * app goes to the first `click` handler, so it's held until the app is up.
 */
export function startPush(p = sdk()) {
  if (started || !p || !p.notifications) return;
  started = true;
  p.notifications.on('click', (click) => {
    if (route) route(click);
    else pendingClick = click;
  });
  // Saved as source and re-run in sw.js, so it can't use anything around it.
  Promise.resolve(
    p.notifications.onPush(
      PUSH_CHANNEL,
      (n) => ({ title: n.title, body: n.text || '', url: n.target || '/' }),
      PUSH_OPTIONS,
    ),
  ).catch((err) => console.warn('[calendar] push handler not registered', err));
}

/** The app is ready for clicks; a held one is delivered now. */
export function routeNotificationClicks(fn) {
  route = fn;
  if (pendingClick) {
    const click = pendingClick;
    pendingClick = null;
    fn(click);
  }
}

/** `{ eventId, uid }` from a click's data, else its target's query. */
export function notificationTarget(click) {
  const data = click && click.data && typeof click.data === 'object' ? click.data : {};
  let params = null;
  try {
    params = new URL((click && click.target) || '/', 'https://calendar.invalid').searchParams;
  } catch {
    /* no usable target */
  }
  const pick = (v) => (typeof v === 'string' ? v : '');
  return {
    eventId: pick(data.eventId) || pick(params && params.get('event')),
    uid: pick(data.uid) || pick(params && params.get('uid')),
  };
}

export function pushStatus(p = sdk()) {
  return p?.notifications ? p.notifications.status(PUSH_OPTIONS) : Promise.resolve('unavailable');
}

/** Includes Puter's subscription state, on the web and inside the desktop. */
export async function pushEnabled(p = sdk()) {
  return (await pushStatus(p)) === 'on';
}

/** Call from a click: `enable()` asks the browser before anything else. */
export async function turnPushOn(p = sdk(), store = null) {
  const n = p.notifications;
  rememberOff(false);
  let on;
  try {
    on = await n.enable(PUSH_OPTIONS);
  } catch (err) {
    if (!err || err.code !== 'push_revoked') throw err;
    on = (await n.requestPermission()) && (await n.enable(PUSH_OPTIONS));
  }
  if (on && store) await store.saveSettings({ storedReminders: true }).catch((err) => console.warn('[calendar] reminder setting', err));
  return on;
}

/**
 * On a website this browser only. Inside the desktop it revokes the app's
 * permission on every device, so stored reminders have nowhere to go either.
 */
export async function turnPushOff(p = sdk(), store = null) {
  rememberOff(true);
  await p.notifications.disable(PUSH_OPTIONS);
  if (p.env === 'app' && store) await store.saveSettings({ storedReminders: false }).catch((err) => console.warn('[calendar] reminder setting', err));
  return true;
}
