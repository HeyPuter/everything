// Reminders while Trips is open (spec §20 [2]). One tab per account runs them (a Web Lock); it reads trips from this
// device's replicas, wakes for the next reminder and shows each once: as a toast when the page is visible, as a
// browser notification when hidden and allowed, otherwise when the page is next visible. Out-of-app delivery is
// notify-out/.
import { toast } from '../../ui/toast.js';
import { t } from '../i18n/index.js';
import { loadTrips } from './replica.js';
import { allReminders, dueNow, nextFire, upcoming } from './schedule.js';
import { reminderHash, reminderLabels, reminderText } from './text.js';
import { browserChoice, browserNotifications, dismissOffer, offerDismissed, permission, setBrowserNotifications, showNotification } from './browser.js';

const REFRESH = 15 * 60_000;
const MAX_WAIT = 15 * 60_000;
const KEEP_FIRED = 60 * 86_400_000;
const PER_TICK = 3;

function firedStore(account) {
  const key = `trips:notify:fired:${account}`;
  const read = () => { try { const value = JSON.parse(globalThis.localStorage?.getItem(key) ?? '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; } };
  return {
    has: (id) => Object.hasOwn(read(), id),
    keys: () => new Set(Object.keys(read())),
    add(ids, now) {
      const value = read();
      for (const id of ids) value[id] = now;
      for (const [id, at] of Object.entries(value)) if (!(now - at < KEEP_FIRED)) delete value[id];
      try { globalThis.localStorage?.setItem(key, JSON.stringify(value)); } catch { /* shown again next session at worst */ }
    },
  };
}

let current = null;
/** The running notifier, for views that list upcoming reminders. */
export const activeReminders = () => current;

/** Starts reminders for one signed-in account until `stop()`. `app.navigate` opens a reminder's trip tab. */
export function startReminders({ account, db, personal, app, window: win = globalThis.window, now = () => Date.now(), zone = Intl.DateTimeFormat().resolvedOptions().timeZone, locks = win?.navigator?.locks } = {}) {
  const uid = typeof account === 'string' ? account : account?.uuid;
  if (!uid || !personal?.spaces?.list) return { stop() {}, refresh: async () => {}, list: () => [], subscribe: () => () => {} };
  const fired = firedStore(uid);
  const doc = win?.document;
  const listeners = new Set();
  const pending = [];
  let reminders = [];
  let timer = 0;
  let refreshed = 0;
  let running = false;
  let stopped = false;
  let release = null;
  let offered = false;
  const offs = [];

  const visible = () => doc?.visibilityState !== 'hidden';
  const notify = () => { for (const listener of [...listeners]) { try { listener(reminders); } catch { /* keep notifying */ } } };
  const open = (item) => { const hash = reminderHash(item); if (hash) { try { app?.navigate?.(hash); } catch { /* route gone */ } } };

  function offerBrowser() {
    if (offered || offerDismissed() || browserChoice() || permission(win) !== 'default') return;
    offered = true;
    dismissOffer();
    toast(t('notify.offer'), { duration: 12_000, action: { label: t('notify.offerAction'), onClick: () => { void setBrowserNotifications(true, win); } } });
  }

  async function show(item) {
    const { title, body } = reminderText(item, { now: now(), zone });
    if (!visible() && browserNotifications(win)) {
      if (await showNotification({ title, body, tag: item.key, onClick: () => open(item) }, win)) return true;
    }
    if (!visible()) return false;
    toast(t('notify.toast', { title, body }), { duration: 10_000, action: reminderHash(item) ? { label: t('notify.open'), onClick: () => open(item) } : undefined });
    offerBrowser();
    return true;
  }

  async function deliver(items) {
    const shown = [];
    for (const item of items.slice(0, PER_TICK)) if (await show(item)) shown.push(item.key); else pending.push(item);
    if (items.length > PER_TICK && visible()) {
      toast(t('notify.more', { count: items.length - PER_TICK }));
      shown.push(...items.slice(PER_TICK).map((item) => item.key));
    } else pending.push(...items.slice(PER_TICK));
    if (shown.length) fired.add(shown, now());
  }

  async function tick() {
    clearTimeout(timer);
    if (stopped || !running) return;
    if (now() - refreshed >= REFRESH) await load();
    const keys = fired.keys();
    const due = dueNow(reminders, { now: now(), fired: keys });
    const waiting = pending.splice(0).filter((item) => !keys.has(item.key) && now() < item.until && !due.some((other) => other.key === item.key));
    if (due.length || waiting.length) await deliver([...waiting, ...due]);
    const next = nextFire(reminders, now());
    timer = setTimeout(() => void tick(), Math.max(1000, Math.min(MAX_WAIT, next === null ? MAX_WAIT : next - now())));
  }

  async function load() {
    try {
      const trips = await loadTrips({ personal, db });
      reminders = allReminders(trips, { uid, now: now(), zone, labels: reminderLabels });
      refreshed = now();
      notify();
    } catch { /* keep the last list; the next refresh retries */ }
  }

  async function refresh() {
    if (stopped) return;
    refreshed = 0;
    if (running) await tick(); else await load();
  }

  const onVisible = () => { if (visible()) void tick(); };
  function activate() {
    if (stopped) return;
    running = true;
    doc?.addEventListener('visibilitychange', onVisible);
    offs.push(() => doc?.removeEventListener('visibilitychange', onVisible));
    const off = personal.subscribe?.('me:spaces', () => void refresh());
    if (off) offs.push(off);
    void refresh();
  }

  // A tab waiting for the lock gives up its request when stopped, so it never takes and keeps the lock afterwards.
  const lockWait = new AbortController();
  if (typeof locks?.request === 'function') {
    locks.request(`trips-reminders-${uid}`, { signal: lockWait.signal }, () => new Promise((resolve) => {
      if (stopped) { resolve(); return; }
      release = resolve;
      activate();
    })).catch(() => {});
  } else activate();
  if (!running) void load();

  const handle = {
    refresh,
    /** Reminders that have not passed yet, soonest first. */
    list: (options) => upcoming(reminders, { now: now(), ...options }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    stop() {
      stopped = true;
      lockWait.abort();
      clearTimeout(timer);
      for (const off of offs.splice(0)) { try { off(); } catch { /* keep stopping */ } }
      listeners.clear();
      release?.();
      if (current === handle) current = null;
    },
  };
  current?.stop();
  current = handle;
  return handle;
}
