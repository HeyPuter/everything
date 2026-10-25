import './styles/index.css';
import { el } from './lib/dom.js';
import { icon } from './ui/icons.js';
import { store } from './lib/store.js';
import { applyTheme } from './ui/theme.js';
import { mountShell } from './ui/shell.js';
import { shouldOnboard, openOnboarding } from './ui/onboarding.js';
import { maybeNotifyDue, catchUpMissedReminders, scheduleTaskReminders } from './lib/reminders.js';
import { debounce } from './lib/util.js';
import { toast } from './ui/toast.js';
import { authView } from './views/auth.js';
import { sharedView } from './views/shared.js';

const appRoot = document.getElementById('app');

/**
 * Offline app shell (production only): sw.js is emitted by the build with
 * a precache manifest, so a previously visited app launches with no
 * network. A waiting update surfaces as a toast; reloading swaps it in.
 */
function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    let reg;
    try {
      reg = await navigator.serviceWorker.register('./sw.js');
    } catch {
      return; // no worker, app works exactly as before
    }
    const hadController = !!navigator.serviceWorker.controller;
    // hadController is false for the whole first-visit session, so it
    // alone can't authorize the reload — a deploy landing during that
    // session would leave the toast's Reload button doing nothing.
    let userAsked = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // Only reload for updates the user asked for — never on the claim
      // that follows the very first install.
      if (userAsked || hadController) location.reload();
    });
    const promptUpdate = (worker) => {
      toast('A new version is ready', {
        icon: 'sparkle',
        duration: 10000,
        action: { label: 'Reload', onClick: () => { userAsked = true; worker.postMessage('skip-waiting'); } },
      });
    };
    // An update that finished installing during an earlier visit sits in
    // reg.waiting and fires no 'updatefound' — prompt for it too, or the
    // "reload for the latest" promise silently skips those loads.
    if (reg.waiting && hadController) promptUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const next = reg.installing;
      next?.addEventListener('statechange', () => {
        if (next.state === 'installed' && navigator.serviceWorker.controller) promptUpdate(next);
      });
    });
  });
}

/**
 * The SDK failed to load (offline launch, CDN outage) but this device has
 * a mirror: boot read-write against it. Every cloud call rejects, which
 * the store already treats as "queue and retry" — reconnecting just needs
 * a reload to get the real SDK.
 */
function installOfflineShim() {
  const offline = async () => { throw new Error('Offline: Puter SDK not loaded'); };
  window.puter = {
    env: 'web',
    offlineShim: true,
    kv: { get: offline, set: offline, del: offline },
    fs: { write: offline, read: offline, delete: offline, getReadURL: offline },
    auth: { isSignedIn: async () => true, getUser: offline, signOut: () => {} },
  };
  store.cloud = window.puter;
  window.addEventListener('online', () => {
    toast('Back online', {
      icon: 'cloud',
      duration: 10000,
      action: { label: 'Reload to sync', onClick: () => location.reload() },
    });
  });
}

function showError(title, message, onRetry) {
  appRoot.replaceChildren(el('div.auth-view', {},
    el('div.empty-icon', { html: icon('wifiOff', 30) }),
    el('h1.auth-title', { style: { fontSize: '22px' } }, title),
    el('p.auth-sub', {}, message),
    el('button.btn.btn-primary.auth-cta', { onclick: onRetry }, 'Try again')
  ));
}

/** Shared-link viewers read a public snapshot; no sign-in, no store. */
function mountSharedViewer() {
  document.title = 'Shared list · Tasks';
  appRoot.replaceChildren(
    el('main.main', { id: 'main' },
      el('div.content', { style: { maxWidth: '640px' } }, sharedView())
    )
  );
  window.addEventListener('hashchange', () => location.reload());
}

async function start() {
  if (location.hash.startsWith('#/shared')) {
    mountSharedViewer();
    return;
  }

  if (typeof puter === 'undefined') {
    // A device that has synced before can still work from its mirror.
    let hasMirror = false;
    try { hasMirror = !!localStorage.getItem('tasks:mirror:v1'); } catch {}
    if (!hasMirror) {
      showError('Could not reach Puter', 'The Puter SDK failed to load. Check your connection and try again.', () => location.reload());
      return;
    }
    installOfflineShim();
  }

  let signedIn = false;
  try {
    signedIn = await Promise.resolve(puter.auth.isSignedIn());
  } catch {
    signedIn = false;
  }

  if (!signedIn) {
    appRoot.replaceChildren(authView({ onSignedIn: boot }));
    return;
  }
  await boot();
}

async function boot() {
  try {
    await store.init();
  } catch (err) {
    console.error(err);
    if (!navigator.onLine) {
      showError('You are offline', 'This device has no local copy of your tasks yet. Connect once and they will be available offline from then on.', () => location.reload());
    } else {
      showError('Could not load your tasks', 'Something went wrong talking to your Puter cloud.', () => location.reload());
    }
    return;
  }

  // Settings win over the pre-paint localStorage value (they sync across devices).
  applyTheme(store.settings.theme || 'system');
  mountShell(appRoot);

  // First run on an empty dataset → guided start (or sample data).
  if (shouldOnboard(store)) openOnboarding();

  setupOfflineBanner();

  // Housekeeping after first paint: due reminders, then archive old
  // completions so the hot document stays small.
  setTimeout(() => {
    try { maybeNotifyDue(store); } catch {}
    try { catchUpMissedReminders(store); } catch {}
    try { scheduleTaskReminders(store); } catch {}
    store.archiveOldCompleted().catch(() => {});
    store.syncShares().catch(() => {});
    store.syncCollab().catch(() => {});
    // Lists shared by username: live updates, new-share notifications, and
    // a listShared() pass that finds shares the notification missed.
    store.startCollabWatch().catch(() => {});
  }, 800);

  // Keep per-task reminder timers current: every data change can move a
  // fire time, and background tabs throttle timers, so re-arm (and catch
  // up on anything the throttled tab slept through) when visible again.
  const rearm = debounce(() => { try { scheduleTaskReminders(store); } catch {} }, 400);
  store.addEventListener('change', rearm);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    try { catchUpMissedReminders(store); } catch {}
    try { scheduleTaskReminders(store); } catch {}
  });

  // Another device may have written while this tab was in the background:
  // refetch (and merge) whenever the tab comes back into view. The store
  // throttles bursts and skips the network when offline.
  const refresh = () => {
    if (document.visibilityState !== 'visible') return;
    store.refreshFromCloud().catch(() => {});
    store.syncCollab().catch(() => {});
    store.discoverShares().catch(() => {});
    // Writes can fail without the device ever going offline, so no 'online'
    // event would retry them; coming back to the tab is the other chance.
    if (store.pendingWrites()) store.flushPending().catch(() => {});
  };
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  // The store flushes its own KV queue on 'online'; collab replicas need
  // the same nudge, or a reconnected tab holds its edits until next focus.
  window.addEventListener('online', () => { store.syncCollab().catch(() => {}); });
  // Polling fallback for shared lists without a live subscription (events
  // unavailable, or links), while the tab is in view.
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    store.syncCollab({ poll: true }).catch(() => {});
    store.discoverShares().catch(() => {});
  }, 60000);
}

/**
 * One banner for "your changes are not in the cloud yet", whether that is
 * because the device is offline or because writes are failing while the
 * browser still believes it is online (server trouble, expired session) —
 * that second case used to be completely silent.
 */
function setupOfflineBanner() {
  let banner = null;
  let shownFor = null;

  const update = () => {
    const state = !navigator.onLine ? 'offline'
      : store.pendingWrites() > 0 ? 'unsynced' : null;
    if (state === shownFor) return;
    shownFor = state;
    banner?.remove();
    banner = null;
    if (!state) return;
    banner = el('div.offline-banner', { role: 'status', html: icon('wifiOff', 15, 2) },
      state === 'offline'
        ? ' Offline. Changes are saved here and sync when you are back'
        : ' Changes are saved here but have not reached your cloud yet');
    document.body.append(banner);
  };

  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  store.addEventListener('sync-state', update);
  update();
}

// Dev-only handle for the mock harness and console debugging.
if (import.meta.env?.DEV) window.__tasks = { store };

registerServiceWorker();
start();
