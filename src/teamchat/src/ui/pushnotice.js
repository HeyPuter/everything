/**
 * A standing notice when notifications would not reach this member, saying
 * why and offering the one thing that fixes it. Each reason, once
 * dismissed, stays quiet on this device for a week.
 */
import { toast } from './toast.js';
import { store } from '../lib/store.js';
import { api } from '../lib/api.js';
import { parseRef } from '../lib/refs.js';
import { EV_GRANT } from '../shared/events.js';

const DISMISSED_KEY = 'tc:push-notice';
const QUIET_MS = 7 * 24 * 3600_000;

/** What stops this browser from showing them. */
const DEVICE = {
  'home-screen': 'On iPhone and iPad, Teamchat can notify you once it is on your Home Screen: tap Share, then Add to Home Screen, and open it from there.',
  blocked: 'Notifications are blocked for Teamchat in this browser. Allow them in the site settings (the icon beside the address), then reload.',
  off: 'Notifications are off on this device.',
};

/** Why the workspace's server cannot reach this member, by the worker's code. */
const REACH = {
  events_kv_handle_not_delegated: 'The owner of this workspace has not allowed Teamchat to share with members yet, so it cannot notify you. Ask them to open Teamchat.',
  account_is_not_verified: 'The owner of this workspace has not confirmed their Puter email, so it cannot notify you yet.',
  events_kv_handle_limit_reached: 'This workspace\'s server has reached its limit of members it can notify.',
  events_kv_handle_requires_account: 'Temporary Puter accounts cannot get notifications. Save your account to get them.',
  recipient_not_accepting_shares: 'Your Puter account is not accepting shares from this workspace\'s owner, so it cannot notify you. Check your Puter sharing settings.',
  no_app_uid: 'This workspace\'s server cannot send notifications. Its owner needs to set it up again.',
};

/** What keeps the owner's teammates from them. */
const TEAM = {
  events_kv_handle_not_delegated: 'Your teammates will not get notifications until you allow Teamchat to share this workspace with them.',
  account_is_not_verified: 'Your teammates will not get notifications until you confirm your Puter email.',
  events_kv_handle_limit_reached: 'Your server has reached its limit of members it can notify.',
};

/** The reason in words, for the settings switch too; null when nothing stands in the way. */
export function pushProblem(health = store.pushHealth()) {
  if (health.state && DEVICE[health.state]) return { key: health.state, text: DEVICE[health.state], device: true };
  if (health.reach) return { key: `reach:${health.reach}`, text: REACH[health.reach] || `Notifications from this workspace are failing (${health.reach}).` };
  if (health.team) return { key: `team:${health.team}`, text: TEAM[health.team] || `Your teammates cannot get notifications from this workspace (${health.team}).`, team: health.team };
  return null;
}

function dismissedAt(key) {
  try {
    return Number(JSON.parse(localStorage.getItem(DISMISSED_KEY) || '{}')[key]) || 0;
  } catch {
    return 0;
  }
}

function noteDismissed(key) {
  try {
    const all = JSON.parse(localStorage.getItem(DISMISSED_KEY) || '{}');
    all[key] = Date.now();
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(all));
  } catch { /* shown again next load */ }
}

/** The owner allows the share members' notifications need, and the worker forgets its refusal. */
async function allowSharing() {
  const granted = await puter.perms.request('kvShare', EV_GRANT).catch(() => false);
  if (!granted) return;
  store.updatePrefs({ evConsent: null }).catch(() => {});
  const url = parseRef(store.wsId)?.url;
  if (url) await api.updateServer(url, { events: true }).catch(() => {});
  store.refreshWorkspace().catch(() => {});
}

function actionFor(problem) {
  if (problem.key === 'off') {
    return {
      label: 'Turn on',
      onClick: () => {
        // The click's own first-press ask (autoEnablePush) may be turning them on already.
        if (store._pushToggling) return;
        store.setPush(true).then((res) => {
          if (!res.on) toast('Notifications were not turned on in this browser', { icon: 'bellOff', duration: 6000 });
        }).catch((err) => toast(err.message || 'Could not turn on notifications', { icon: 'alert', duration: 6000 }));
      },
    };
  }
  if (problem.team === 'events_kv_handle_not_delegated' && typeof puter?.perms?.request === 'function') {
    return { label: 'Allow', onClick: () => { allowSharing().catch(() => {}); } };
  }
  return null;
}

export function mountPushNotice() {
  let shown = null; // { key, dismiss }
  const update = () => {
    const problem = store.ws?.sample ? null : pushProblem();
    const key = problem && (problem.device ? problem.key : `${store.wsId}:${problem.key}`);
    if (shown && shown.key === key) return;
    shown?.dismiss();
    shown = null;
    if (!problem || Date.now() - dismissedAt(key) < QUIET_MS) return;
    const handle = toast(problem.text, {
      icon: 'bellOff',
      duration: Infinity,
      action: actionFor(problem),
      dismissible: true,
      onDismiss: () => {
        noteDismissed(key);
        if (shown?.key === key) shown = null;
      },
    });
    shown = { key, dismiss: () => handle?.dismiss?.() };
  };
  store.on('push', update);
  store.on('workspace', update);
  store.on('profile', update);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) store.recheckPush().catch(() => {});
  });
  update();
}
