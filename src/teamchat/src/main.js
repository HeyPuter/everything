import './styles/index.css';
import { el } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { applyTheme } from './ui/theme.js';
import { mountShell } from './ui/shell.js';
import { authView } from './views/auth.js';
import { store } from './lib/store.js';
import { parseHash } from './lib/router.js';
import { loadEmoji } from './lib/emoji.js';
import { registerServiceWorker, captureInstallPrompt, listenForPushes } from './lib/pwa.js';
import { toast } from './ui/toast.js';
import { mountOfflineBanner } from './ui/offline.js';
import { navigate } from './lib/router.js';
import { populateSampleData } from './lib/demo.js';

const appRoot = document.getElementById('app');

function showError(title, message, onRetry) {
  appRoot.replaceChildren(el('main.auth-view', {},
    el('div.empty-icon', { html: icon('wifiOff', 30) }),
    el('h1.auth-title', { style: { fontSize: '22px' } }, title),
    el('p.auth-sub', {}, message),
    el('button.btn.btn-primary.auth-cta', { type: 'button', onclick: onRetry }, 'Try again')));
}

const SDK_URL = 'https://js.puter.com/v2/';

/**
 * Wait for the deferred Puter SDK script (it loads ahead of this module).
 * Offline, the wait is short: a script the service worker had cached has
 * run by now, and one it had not cannot load until the network is back.
 */
async function waitForPuter(ms = navigator.onLine === false ? 1000 : 6000) {
  const start = Date.now();
  while (typeof puter === 'undefined') {
    if (Date.now() - start > ms) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

/**
 * Ask for the SDK again after its first load failed (the app opened with no
 * network, the script not yet in the service worker's cache): a browser does
 * not retry a script tag that failed, so a fresh one is added, at the same
 * address the page names.
 */
function loadSdk() {
  const src = document.querySelector('script[src*="js.puter.com"]')?.getAttribute('src') || SDK_URL;
  document.head.append(el('script', { src, async: true }));
}

async function start() {
  // The offline strip, before anything can fail for want of a network: an
  // installed app opened offline finds its shell in the cache, gets as far
  // as reading the account, and lands on "Could not load your account" with
  // a message from the SDK that says nothing about the network. Mounted here
  // it says "You are offline" over that page, the sign-in page and the app
  // alike, and clears when the network is back. Its line about messages
  // going out later is kept for the app itself (nothing is sent from the
  // pages before it), and a reconnect brings the poll forward when a
  // workspace is open (pokeSync does nothing before one is).
  mountOfflineBanner({ onReconnect: () => store.pokeSync(), note: () => !!appRoot.querySelector('.app-frame') });
  // The network coming back while "Could not load your account" or "Could
  // not reach Puter" is showing asks again on its own for what could not be
  // had without it, the account or the SDK itself: those pages are where an
  // app opened offline lands, and their Try again reloads the whole page,
  // which is a lot to ask of someone who only had to wait for the
  // connection. Only then: the sign-in page and the app itself are left
  // alone, and a boot or an entry already in flight is not doubled.
  window.addEventListener('online', () => {
    if (accountFailed) boot();
    else if (sdkFailed) enter();
  });
  // The installable app: cached shell, an update prompt when a new build is
  // waiting, and notification clicks that land on the right message. This
  // runs before sign-in so the shell is cached from the first visit.
  // The update prompt stays until it is answered: it used to leave after
  // fifteen seconds, and landing while the reader was typing it went unseen,
  // with the new version then waiting until the tab was next opened. Reload
  // is the reader's to press (a draft being typed is kept for the page that
  // comes back); Dismiss puts the prompt away for this visit. One at a time:
  // a second build arriving replaces the prompt rather than stacking one.
  let updatePrompt = null;
  registerServiceWorker({
    onUpdate: (apply) => {
      updatePrompt?.dismiss();
      updatePrompt = toast('A new version of Teamchat is ready', { icon: 'sparkle', duration: Infinity, dismissible: true, action: { label: 'Reload', onClick: apply } });
    },
    onMessage: (msg) => { if (msg?.type === 'navigate' && typeof msg.route === 'string' && msg.route.startsWith('#/')) navigate(msg.route); },
    // Which workspace this window shows, for the push handler deciding
    // whether a banner would only repeat the screen: the bare workspace id,
    // since a push names its workspace without the server half of the ref.
    // Only a page actually running that workspace answers with it — the
    // hash survives sign-out and boot failures, and a window that merely
    // wears the address cannot badge, bold, or chime in the banner's place.
    onRoute: () => {
      const ws = String(parseHash(location.hash).ws || '').split('@')[0];
      const open = !!store.ws && String(store.wsId || '').split('@')[0] === ws;
      return { ws: open && ws ? ws : null };
    },
  }).catch(() => {});
  await enter();
}

/**
 * A tap on one of Teamchat's Puter notifications opens the message it is
 * about. Added as soon as the SDK is there, so the tap that launched the app
 * reaches it too (Puter hands that one to the first handler only).
 */
let clicksHeard = false;
function listenForNotificationClicks() {
  if (clicksHeard || typeof puter.notifications?.on !== 'function') return;
  clicksHeard = true;
  puter.notifications.on('click', ({ uid, target, data } = {}) => {
    const route = typeof data?.r === 'string' ? data.r : String(target || '').replace(/^\//, '');
    if (route.startsWith('#/')) navigate(route);
    // Closes the same notification on the user's other devices.
    if (uid) puter.notifications.dismiss(uid).catch(() => {});
  });
}

// Whether "Could not reach Puter" is the page showing, for the retry the
// network's return brings (see start); and whether an entry is in flight, so
// that retry cannot run two at once.
let sdkFailed = false;
let entering = false;

/**
 * From the SDK on: wait for it (asking for it afresh when its first load
 * failed), then the sign-in page, or the app.
 */
async function enter() {
  if (entering) return;
  entering = true;
  const again = sdkFailed;
  sdkFailed = false;
  try {
    if (again && typeof puter === 'undefined') loadSdk();
    // Offline, the wait is the short one (see waitForPuter). A network that
    // comes back inside it says so before the wait has failed, so no
    // `online` event follows the failure to bring the retry (see start):
    // when the browser says the network is back by then, the SDK is asked
    // for once more before anything is shown.
    const offline = navigator.onLine === false;
    let ok = await waitForPuter();
    if (!ok && offline && navigator.onLine !== false && typeof puter === 'undefined') {
      loadSdk();
      ok = await waitForPuter(6000);
    }
    if (!ok) {
      sdkFailed = true;
      // What failed and what to try: the script is what did not come, and a
      // content blocker stops it as surely as a lost connection does, so
      // "check your connection" alone sent a reader who was online looking
      // in the wrong place.
      showError('Could not reach Puter', 'The Puter script (js.puter.com) did not load. Check your connection or a content blocker, then try again.', () => location.reload());
      return;
    }
    listenForNotificationClicks();
    listenForPushes();
    let signedIn = false;
    try {
      signedIn = await Promise.resolve(puter.auth.isSignedIn());
    } catch {
      signedIn = false;
    }
    if (!signedIn) {
      const r = parseHash(location.hash);
      appRoot.replaceChildren(authView({ onSignedIn: boot, pendingInvite: r.name === 'join' ? r.code : null }));
      return;
    }
  } finally {
    entering = false;
  }
  await boot();
}

// Whether the "Could not load your account" page is the one showing, for the
// retry the network's return brings (see start); and whether a boot is in
// flight, so that retry and a sign-in cannot run two at once.
let accountFailed = false;
let booting = false;

async function boot() {
  if (booting) return;
  booting = true;
  try {
    await store.loadMe();
  } catch (e) {
    console.error(e);
    booting = false;
    if (e?.status === 401) {
      // The sign-in page is the one showing now, not the account error: the
      // network's return must not start the account over under a sign-in in
      // progress (a retry after an outage can end here when the session had
      // lapsed meanwhile).
      accountFailed = false;
      try {
        await puter.auth.signOut();
      } catch {
        /* ignore */
      }
      appRoot.replaceChildren(authView({ onSignedIn: boot }));
    } else {
      accountFailed = true;
      showError('Could not load your account', e?.message || 'Something went wrong talking to Puter.', () => location.reload());
    }
    return;
  }
  booting = false;
  accountFailed = false;
  // The saved preference wins over the pre-paint localStorage value (it syncs across devices).
  if (store.profile?.prefs?.theme) applyTheme(store.profile.prefs.theme);
  mountShell(appRoot);
  // The emoji table is a separate chunk; fetch it now so messages and the
  // picker have it by the time a workspace is on screen.
  loadEmoji().catch(() => {});
}

captureInstallPrompt();

// A file dropped anywhere but the composer would otherwise be opened by the
// browser in place of the app, taking an unsent message with it. The composer
// handles its own drops before this runs; everywhere else the drop is inert.
for (const type of ['dragover', 'drop']) {
  document.addEventListener(type, (e) => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
  });
}

// Console demo helper is available in deployed builds as well as development.
window.teamchat = { populateSampleData };
if (import.meta.env?.DEV) window.__tc = { store };

start();
