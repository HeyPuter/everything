import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/views.css';
import './styles/offline.css';

import { el, clear } from './js/dom.js';
import { icon } from './js/icons.js';
import { toast } from './js/toast.js';
import { isSignedIn, signIn, getUser } from './js/auth.js';
import { createStore } from './js/store.js';
import { createApp, applyTheme } from './js/app.js';
import { createOfflineKv } from './js/offline-store.js';
import { createOffline, renderOfflineScreen } from './js/offline.js';
import { createRsvpLinks } from './js/rsvp-links.js';
import { createInvites } from './js/invites.js';
import { createBooking } from './js/booking.js';
import { createContacts } from './js/contacts.js';
import { createMeetings } from './js/meetings.js';
import { createMailbox } from './js/mailbox.js';
import { createMailIntake } from './js/mail-intake.js';
import { createMailReply } from './js/mail-reply.js';
import { grantedScope, readLaunchContext } from './js/api/protocol.js';
import { createMethods } from './js/api/methods.js';
import { startApiServer } from './js/api/server.js';
import { createSampleDataPopulator } from './js/demo.js';
import { startPush, routeNotificationClicks, autoEnablePush, SERVICE_WORKER } from './js/push.js';
import { createStoredReminders } from './js/stored-reminders.js';

let demoSession = null;
window.calendar = { populateSampleData: createSampleDataPopulator(() => isSignedIn() ? demoSession : null) };

const root = document.getElementById('app');

// Who (if anyone) launched us, and how. Resolved once, before any sign-in flow,
// so a boot after signing in still knows its caller.
let launch = { callerApp: '', serviceMode: false, inPuterApp: false };

function showLoading(message = 'Loading your calendar…') {
  clear(root);
  root.append(
    el('div', { class: 'screen loading-screen' }, [
      el('div', { class: 'spinner' }),
      el('p', { text: message }),
    ]),
  );
}

function showError(message) {
  clear(root);
  // Terminal, interactive screen — no longer "busy" (mirrors app.js / offline.js).
  root.removeAttribute('aria-busy');
  root.append(
    el('div', { class: 'screen' }, [
      el('div', { class: 'auth-card' }, [
        el('img', { class: 'auth-card__logo', src: '/icon-192.png', alt: 'Calendar', width: '56', height: '56' }),
        el('h1', { class: 'auth-card__title', text: 'Something went wrong' }),
        el('p', { class: 'auth-card__sub', text: message }),
        el('button', {
          class: 'btn btn--primary btn--block',
          type: 'button',
          text: 'Reload',
          on: { click: () => window.location.reload() },
        }),
      ]),
    ]),
  );
}

function showSignIn() {
  clear(root);
  // Terminal, interactive screen — no longer "busy" (mirrors app.js / offline.js).
  root.removeAttribute('aria-busy');
  const btn = el('button', {
    class: 'btn btn--primary btn--block',
    type: 'button',
    html: icon('calendar', { size: 'sm' }) + '<span>Sign in</span>',
  });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await signIn();
      boot();
    } catch {
      btn.disabled = false;
    }
  });
  root.append(
    el('div', { class: 'screen' }, [
      el('div', { class: 'auth-card' }, [
        el('img', { class: 'auth-card__logo', src: '/icon-192.png', alt: 'Calendar', width: '56', height: '56' }),
        el('h1', { class: 'auth-card__title', text: 'Calendar' }),
        el('p', {
          class: 'auth-card__sub',
          text: 'Sign in with your free Puter account to keep your events synced across every device. Your data stays in your own storage.',
        }),
        btn,
      ]),
    ]),
  );
}

/** Run `fn` once the browser is idle, so background work never delays a render.
 *  Falls back to a plain delay where requestIdleCallback is unavailable. */
function whenIdle(fn, timeout = 3000) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout });
  else setTimeout(fn, 1200);
}

function waitForPuter(timeout = 8000) {
  return new Promise((resolve, reject) => {
    if (typeof puter !== 'undefined' && puter.kv) return resolve();
    const started = Date.now();
    const iv = setInterval(() => {
      if (typeof puter !== 'undefined' && puter.kv) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - started > timeout) {
        clearInterval(iv);
        reject(new Error('timeout'));
      }
    }, 60);
  });
}

/**
 * Register the service worker (installability + offline shell). Standalone web
 * only — never inside the Puter GUI — and only in a production build. Deferred
 * to `load` and fire-and-forget so it never blocks or fails boot. In dev, any
 * previously-installed prod SW is unregistered so it can't serve stale assets.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const inPuterGui = typeof puter !== 'undefined' && (puter.env === 'app' || puter.env === 'gui');
  if (import.meta.env.PROD && !inPuterGui) {
    // `updateViaCache: 'none'` forces the browser to revalidate sw.js from the
    // network on every update check — the kill-switch: a fixed/neutered sw.js
    // always reaches clients on their next load.
    const register = () =>
      navigator.serviceWorker.register(SERVICE_WORKER, { updateViaCache: 'none' }).catch(() => {});
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  } else if (import.meta.env.DEV) {
    navigator.serviceWorker
      .getRegistrations()
      .then((regs) => regs.forEach((r) => r.unregister()))
      .catch(() => {});
  }
}

// Re-entrancy guard: a double-click on the offline "Retry" (or a fast repeat of
// any boot trigger) must not spin up a second app instance — that would leak a
// second reminder scheduler, tick, and event listeners with no teardown.
let booting = false;
async function boot() {
  if (booting) return;
  booting = true;
  try {
    await bootInner();
  } finally {
    booting = false;
  }
}

async function bootInner() {
  demoSession = null;
  showLoading();

  try {
    await waitForPuter();
  } catch {
    // Offline with no SDK cached (e.g. first-ever visit offline): a friendly
    // offline screen beats a generic "check your connection" error.
    if (navigator.onLine === false) renderOfflineScreen(root, { onRetry: boot });
    else showError('Could not load Puter.js. Please check your connection and reload.');
    return;
  }

  // Safe to read the launch parameters now: they come off the SDK, which the
  // page loads synchronously before this module, but only `puter.env` tells us
  // whether we are an app window at all.
  launch = readLaunchContext(window);
  if (launch.serviceMode) {
    // Another app launched us purely for the API — no UI, no window.
    await bootService();
    return;
  }

  // Safe to register now: the SDK is loaded so `puter.env` is defined.
  registerServiceWorker();
  // Before sign-in, so the click that opened the calendar isn't missed.
  startPush();

  if (!isSignedIn()) {
    // Signing in needs the network; show the offline screen rather than a dead
    // sign-in button when there's no connection.
    if (navigator.onLine === false) renderOfflineScreen(root, { onRetry: boot });
    else showSignIn();
    return;
  }

  try {
    const user = await getUser();
    // Wrap puter.kv so store.load() transparently falls back to a local
    // snapshot when offline. The store is otherwise unchanged.
    const kv = createOfflineKv(puter.kv);
    kv.ensureUser(user && (user.uuid || user.id || user.username));

    const rawStore = createStore(kv);
    // React to the initially-loaded theme as early as possible.
    kv.resetReachable();
    await rawStore.load();

    const effectivelyOffline = navigator.onLine === false || kv.wasOffline();
    if (effectivelyOffline && !kv.hasSnapshot()) {
      // Offline and never synced on this device — nothing to show. Don't render
      // an empty calendar that looks like data loss.
      renderOfflineScreen(root, { onRetry: boot });
      return;
    }

    applyTheme(rawStore.getSettings().theme);

    const offline = createOffline({
      toast,
      // Reconnect heals staleness: a real cloud reload (which also refreshes the
      // snapshot). Resolves true only if the cloud was actually reachable.
      onReconnectRefresh: async () => {
        kv.resetReachable();
        await rawStore.load();
        return !kv.wasOffline();
      },
    });
    // The app only ever sees the gated store, so every write path is guarded
    // with no change to app.js / views / drag.
    const store = offline.gate(rawStore);
    // Launched by an app we serve, but with a window of our own (the caller
    // asked for the calendar, not the headless service). Serve the API from
    // here too, so it isn't forced to open a second, hidden instance to talk to
    // us. The gated store is deliberate: a write from another app while we're
    // offline is refused exactly like one of the user's own.
    if (launch.callerApp) serveApi(launch.callerApp, { store });
    // Self-serve RSVP links for guests, served by a worker in the user's own
    // Puter account (deployed on first use). Uses the gated store, so its
    // response merges are offline-guarded like every other write.
    const rsvp = createRsvpLinks({ kv, store, user });
    // Emailing those links out, through the calendar's shared email worker.
    // Never automatic — it sends only what the host explicitly presses send on
    // — so it needs no store subscription, just its own record of what went
    // where (loaded by start(), below).
    const invites = createInvites({ kv, store, rsvp, user });
    // Guest suggestions from the user's own address book, read from the Contacts
    // app over an AppConnection. Inert outside the Puter desktop, where there is
    // no other app to talk to. `userKey` scopes its cached snapshot to this
    // account, exactly as the offline calendar snapshot is scoped.
    const contacts = createContacts({
      userKey: (user && (user.uuid || user.id || user.username)) || '',
    });
    // Booking links: Calendly-style pages served by the same per-user worker
    // as RSVP links (booking.js reuses rsvp's admin channel). The gated store
    // keeps its pulled-booking writes offline-guarded like everything else.
    const booking = createBooking({ kv, store, rsvp, user });
    // Meeting links for the Puter Meetings app, minted locally from its
    // published stateless recipe (see meetings.js) — no API, no launch,
    // works on the open web too.
    const meetings = createMeetings();
    // Inbound-mail invitations: connection lifecycle (mailbox.js), trust
    // policy + pending tray (mail-intake.js), RSVP-by-email (mail-reply.js).
    // A throw here must not take boot down; it just means the feature is off.
    let mail = null;
    // Late-bound: the intake exists before the app does, and the app is what
    // knows how to show the tray.
    let onMailDetected = null;
    try {
      const mailbox = createMailbox({ kv, store, user });
      const intake = createMailIntake({
        kv,
        store,
        mailbox,
        contacts,
        user,
        onDetected: (n) => onMailDetected && onMailDetected(n),
      });
      const reply = createMailReply({ store, user });
      mail = { mailbox, intake, reply };
    } catch (err) {
      console.error(err);
      mail = null;
    }
    const storedReminders = createStoredReminders({
      store, kv: puter.kv,
      refresh: async () => {
        const before = kv.fallbackCount();
        await store.load();
        if (kv.fallbackCount() !== before) throw new Error('Reminders need a current cloud calendar');
      },
    });
    const app = createApp(root, { store, user, rsvp, contacts, invites, booking, meetings, mail, storedReminders });
    storedReminders.start();
    autoEnablePush(puter, store).catch((err) => console.warn('[calendar] push not turned on', err));
    demoSession = { store, app };
    onMailDetected = (n) => app.notifyMailDetected(n);
    routeNotificationClicks((click) => app.openNotification(click));
    offline.bindRender(app.render);
    offline.start({ online: !effectivelyOffline });
    // Fire-and-forget: RSVP/booking syncing are background concerns and must
    // never be able to take the app down with them.
    Promise.resolve(rsvp.start()).catch(() => {});
    Promise.resolve(invites.start()).catch(() => {});
    Promise.resolve(booking.start()).catch(() => {});
    if (mail) {
      Promise.resolve(mail.mailbox.start()).catch(() => {});
      Promise.resolve(mail.intake.start()).catch(() => {});
    }
    // Read the address book now rather than when someone starts typing a guest.
    // Reading it means launching Contacts, and a launch is the one thing here
    // that can disturb the window the user is working in — far better that it
    // happens as the calendar opens, with nothing half-typed to lose. Usually a
    // no-op: the snapshot from a previous session is restored from disk instead.
    // Deferred to idle so it never competes with the first render, and skipped
    // while offline (there is nothing to launch into).
    if (!effectivelyOffline) whenIdle(() => contacts.warm());
    // Coming back to the calendar is the other half of that: the most likely
    // reason someone was away is that they were in Contacts adding the person
    // they are about to invite. Re-read then (throttled inside `revalidate`, and
    // only for someone who has used suggestions this session, so an idle tab
    // never launches anything).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (navigator.onLine === false || !contacts.inUse()) return;
      contacts.revalidate();
    });
  } catch (err) {
    console.error(err);
    // A failure here is most likely an expired/again-required session, or a
    // network drop mid-boot.
    if (navigator.onLine === false) renderOfflineScreen(root, { onRetry: boot });
    else if (!isSignedIn()) showSignIn();
    else showError('We could not load your calendar. Please try again.');
  }
}

/* ---- App-to-app API ------------------------------------------------------ */

// How long a headless service instance stays alive with nothing to do. The
// client re-launches us on demand, and closing the window frees the connection
// on both sides, so a short-lived service is the tidy default.
const SERVICE_IDLE_MS = 5 * 60 * 1000;

// The API server this instance is running, if any. Kept so a second boot —
// the offline screen's Retry re-runs bootInner — replaces it instead of
// stacking a second listener on the same connection, which would answer every
// request twice.
let apiServer = null;

/** Hand the API to the app that launched us. Returns the server, or null when
 *  that app has no grant (see js/api/protocol.js). */
function serveApi(callerApp, { store, onActivity } = {}) {
  let connection = null;
  try {
    connection = puter.ui.parentApp();
  } catch {
    return null;
  }
  if (!connection) return null;
  if (apiServer) apiServer.stop();
  // A scoped grant (Meetings sees only events with a meeting link) is applied
  // inside the method table, from the caller's identity — never from anything
  // the caller sends.
  const scope = grantedScope(callerApp);
  apiServer = startApiServer({
    connection,
    callerApp,
    methods: createMethods({ store, scope }),
    scope,
    subscribe: (fn) => store.subscribe(fn),
    // So a `changed` notice means the calendar changed, and not that the store
    // emitted — which it also does for a re-read, and for settings and tasks.
    revision: () => store.revision(),
    onActivity,
  });
  return apiServer;
}

/**
 * Headless boot: another app launched us purely to use the calendar API, so
 * there is no UI to mount and no window to show. index.html has already hidden
 * the window (before this bundle loaded, to avoid a flash); we hide again here
 * because that early attempt is best-effort.
 *
 * Note what this instance deliberately does NOT start: no reminder scheduler, no
 * RSVP sync, and no address-book client. A service instance is one caller's
 * question answered, not a second calendar running in the background — and the
 * contacts client in particular would have this app launching the very app most
 * likely to have launched it.
 */
async function bootService() {
  hideWindow();
  if (!isSignedIn()) {
    // Inside the desktop a launched app inherits the session, so this means
    // nobody is signed in at all — there is nothing to serve and no way to ask.
    // When the desktop can't close us, the window that gets shown must explain
    // itself: without a render it would still hold the boot spinner, stuck
    // "loading" (aria-busy and all) forever.
    console.warn('[calendar] the calendar API needs a signed-in Puter session');
    renderServicePanel(launch.callerApp, 'signed-out');
    if (!exit()) showWindow();
    return;
  }

  // The plain cloud store: the offline snapshot and its write-gate exist to keep
  // a *window* usable and honest while disconnected, and a caller is better told
  // that a read failed than handed this device's last-synced copy of a calendar
  // it is about to write to.
  const store = createStore(puter.kv);

  let idleTimer = null;
  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (apiServer) apiServer.stop();
      // Every other exit() here checks the return: on a desktop without
      // puter.exit, exiting silently would leave a hidden zombie whose
      // stopped server answers nothing. Show the window (its panel already
      // says it can be closed) so the instance is at least visible.
      if (!exit()) {
        renderServicePanel(launch.callerApp, 'idle');
        showWindow();
      }
    }, SERVICE_IDLE_MS);
  };
  const server = serveApi(launch.callerApp, { store, onActivity: touch });

  if (!server) {
    // Not an app we serve. Don't linger as an invisible process: close the
    // window if we can, and otherwise show it with an explanation rather than
    // leaving a hidden instance the user can't see.
    console.warn(
      `[calendar] "${launch.callerApp || 'an unidentified app'}" is not allowed to use the calendar API`,
    );
    renderServicePanel(launch.callerApp, 'denied');
    if (!exit()) showWindow();
    return;
  }

  renderServicePanel(launch.callerApp, 'serving');
  touch();
}

const SERVICE_PANEL_COPY = {
  serving: (app) =>
    `${app} is using your calendar. Nothing leaves your Puter account, and you can close this window at any time.`,
  denied: (app) => `${app} asked to use your calendar and was not allowed to. You can close this window.`,
  'signed-out': (app) =>
    `${app} asked to use your calendar, but nobody is signed in to Puter. You can close this window.`,
  idle: (app) => `${app} finished using your calendar. You can close this window.`,
};

/** What the user would see if hiding the window failed, or if they un-hide it
 *  from the taskbar. */
function renderServicePanel(callerApp, mode) {
  clear(root);
  root.removeAttribute('aria-busy');
  // The caller's name comes from the launch URL, so it goes in as text, never
  // as markup.
  const app = callerApp ? callerApp[0].toUpperCase() + callerApp.slice(1) : 'Another app';
  root.append(
    el('div', { class: 'screen' }, [
      el('div', { class: 'auth-card' }, [
        el('img', {
          class: 'auth-card__logo',
          src: '/icon-192.png',
          alt: 'Calendar',
          width: '56',
          height: '56',
        }),
        el('h1', { class: 'auth-card__title', text: 'Calendar' }),
        el('p', {
          class: 'auth-card__sub',
          text: (SERVICE_PANEL_COPY[mode] || SERVICE_PANEL_COPY.serving)(app),
        }),
      ]),
    ]),
  );
}

function hideWindow() {
  try {
    puter.ui.hideWindow();
  } catch {
    /* best-effort: an older desktop may not support it */
  }
}

function showWindow() {
  try {
    puter.ui.showWindow();
  } catch {
    /* best-effort */
  }
}

/** Close this instance. Returns false when the SDK can't (nothing happened). */
function exit() {
  try {
    if (typeof puter.exit !== 'function') return false;
    puter.exit(0);
    return true;
  } catch {
    return false;
  }
}

// No listener for `prefers-color-scheme`: with no explicit theme the OS scheme
// is followed entirely in CSS (tokens.css) and by the media-scoped
// <meta name="theme-color"> pair in index.html, both of which the browser
// re-evaluates on its own. There is nothing for script to do, which is why the
// handler that used to sit here had an empty body.
boot();
