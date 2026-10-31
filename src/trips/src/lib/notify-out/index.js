// Out-of-app notifications, app side: settings storage, the reminder schedule and the background subscriptions.
// The delivery itself runs in the published events handler (`./handler.js`, built from worker-notify/).
import { browserTimeZone, zonedParts } from '../../shared/dates.js';
import { DomainError } from '../../shared/errors.js';
import { KEYS, cleanNotifyPrefs, cleanSecret } from './model.js';
import { safeUrl } from './guard.js';
import { tripReminders, forwardedReminders, withoutCovered, writeSchedule, nextDue, requestTest } from './schedule.js';
import { backgroundAvailable, desiredSubscriptions, ensureBackgroundConsent, reconcileSubscriptions, removeSubscriptions } from './subscriptions.js';

export { KEYS, HANDLER_NAME, CATEGORIES, CHANNELS, PUSH_CHANNELS, WEBHOOK_FORMATS, TRIP_MODES, DIGEST_EVERY, LEAD_DAYS, DEFAULT_NTFY, LIMITS,
  cleanNotifyPrefs, cleanSecret, newSecret, newTopic, validTopic, validEmail } from './model.js';
export { urlProblem, safeUrl } from './guard.js';
export { todoReminders, tripReminders, forwardedReminders, writeSchedule } from './schedule.js';
export { backgroundAvailable, ensureBackgroundConsent, tripsToWatch, wantsActivity } from './subscriptions.js';

const HOUR = 3_600_000;
const RESYNC = 6 * HOUR;
const MEMO = 'trips:notify:subs:';
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const storageOf = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };
const today = (now) => zonedParts(now, browserTimeZone()).date;

/** Every personal key this feature writes, for "delete all my data": fixed keys plus the last 48 hourly buckets. */
export function notifyKeys(now = Date.now()) {
  const buckets = Array.from({ length: 49 }, (_, index) => KEYS.bucket(new Date(now - index * HOUR).toISOString().slice(0, 13).replace(/[-T]/g, '')));
  return [KEYS.prefs, KEYS.secret, KEYS.sched, KEYS.rev, KEYS.retry, KEYS.digest, KEYS.status, ...buckets];
}

/** Ends the background subscriptions and deletes every notification key. */
export async function removeNotifyOutData(puter, now = Date.now()) {
  await removeSubscriptions(puter);
  for (const key of notifyKeys(now)) await puter.kv.del(key).catch((error) => { if (error?.status && error.status !== 404) throw error; });
}

/** `{prefs, secret, status}` read in one batched get. Secrets are never cached on the device. */
export async function loadNotify(puter) {
  const [prefs, secret, status] = await puter.kv.get([KEYS.prefs, KEYS.secret, KEYS.status]);
  return { prefs: cleanNotifyPrefs(prefs), secret: cleanSecret(secret), status: plain(status) ? status : {} };
}

/** Path writes to `me:notify`, so devices changing different settings never overwrite each other. */
export async function savePrefs(puter, paths, remove = []) {
  if (Object.keys(paths).length) await puter.kv.update(KEYS.prefs, { v: 1, ...paths });
  if (remove.length) await puter.kv.remove(KEYS.prefs, ...remove);
}

/**
 * Merges `changes` into `me:notify:secret` (written with `disableSharing`). URLs are checked with the reach rules;
 * `null` removes a field. Resolves the cleaned secret.
 */
export async function saveSecret(puter, changes) {
  const current = cleanSecret(await puter.kv.get(KEYS.secret));
  const next = { ...current };
  for (const [field, value] of Object.entries(changes)) {
    if (value == null || value === '') { delete next[field]; continue; }
    next[field] = field === 'webhookUrl' ? safeUrl(value.trim()) : typeof value === 'string' ? value.trim() : value;
  }
  const cleaned = cleanSecret(next);
  for (const field of Object.keys(next)) if (!Object.hasOwn(cleaned, field)) throw new DomainError(`invalid_${field}`, 400);
  await puter.kv.set(KEYS.secret, { v: 1, ...cleaned }, { disableSharing: true });
  return cleaned;
}

export { requestTest };

/**
 * Brings the reminder schedule and the subscriptions in line with the settings and `me:spaces`. `reminders`, when
 * given, returns the in-app reminder model's items to forward as well. Unchanged inputs skip the subscription
 * listing for 6 hours unless `force`. Resolves `{state, watched, reasons, limit}` where state is `off`, `on`,
 * `unavailable` or `consent`.
 */
export async function syncNotifyOut({ puter, personal, account, origin = globalThis.location?.origin, now = Date.now(), force = false, storage = storageOf(), reminders = null }) {
  const prefs = cleanNotifyPrefs(await puter.kv.get(KEYS.prefs));
  const entries = await personal.spaces.list();
  if (prefs.on) {
    // A failing provider leaves its earlier items in place instead of removing them.
    const list = reminders ? await Promise.resolve().then(reminders).catch(() => null) : null;
    const forwarded = list ? forwardedReminders(list, { now }) : {};
    const items = { ...withoutCovered(tripReminders(entries, { lead: prefs.lead, now }), forwarded), ...forwarded };
    await writeSchedule(puter, items, (id) => id.startsWith('trip-') || (list !== null && id.startsWith('q-')), now);
  }
  if (!backgroundAvailable(puter)) return { state: 'unavailable', watched: new Set(), reasons: new Map(), limit: false, prefs };
  const { list, reasons } = desiredSubscriptions({ entries, prefs, uid: account.uuid, origin, today: today(now), appUid: puter.appID });
  const signature = list.map((item) => item.subject).join('|');
  const memoKey = MEMO + account.uuid;
  let memo = null;
  try { memo = JSON.parse(storage?.getItem(memoKey) ?? 'null'); } catch { memo = null; }
  if (!force && memo?.signature === signature && now - memo.at < RESYNC && Array.isArray(memo.watched)) {
    return { state: prefs.on ? 'on' : 'off', watched: new Set(memo.watched), reasons, limit: Boolean(memo.limit), prefs };
  }
  let result;
  try { result = await reconcileSubscriptions(puter, list); }
  catch (error) {
    if (error?.code === 'events_background_consent_required') return { state: 'consent', watched: new Set(), reasons, limit: false, prefs };
    throw error;
  }
  try { storage?.setItem(memoKey, JSON.stringify({ signature, at: now, watched: [...result.watched], limit: result.limit })); } catch { /* per-device convenience */ }
  return { state: prefs.on ? 'on' : 'off', ...result, reasons, prefs };
}

/** Turns background notifications on (asking for consent first, from a click) or off. */
export async function setNotifyOn(context, on) {
  const { puter } = context;
  if (on && backgroundAvailable(puter)) await ensureBackgroundConsent(puter);
  await savePrefs(puter, { on });
  return syncNotifyOut({ ...context, force: true });
}

const running = new Map();

/**
 * Starts the per-session runtime: syncs shortly after start and after `me:spaces` changes, and while the app is
 * open wakes the handler when a reminder falls due. `reminders` is the in-app reminder provider (see
 * `syncNotifyOut`). Returns a stop function; one runtime per account.
 */
export function startNotifyOut({ puter, personal, account, origin = globalThis.location?.origin, reminders = null, delay = 10_000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (!puter?.kv || !personal?.spaces || !account?.uuid) return () => {};
  const live = running.get(account.uuid);
  if (live) { live.refs += 1; return live.release; }
  let stopped = false;
  let syncTimer = null;
  let pokeTimer = null;
  const sync = async () => {
    syncTimer = null;
    if (stopped) return;
    try {
      const result = await syncNotifyOut({ puter, personal, account, origin, reminders });
      if (!stopped && result.prefs.on) await planPoke();
    } catch { /* retried on the next change or start */ }
  };
  const later = (ms) => { if (!stopped) { clearTimer(syncTimer); syncTimer = setTimer(sync, ms); } };
  async function planPoke() {
    clearTimer(pokeTimer);
    const due = nextDue(await puter.kv.get(KEYS.sched), Date.now());
    if (due == null || stopped) return;
    pokeTimer = setTimer(async () => {
      if (stopped) return;
      try { await puter.kv.update(KEYS.sched, { tick: Date.now() }); } catch { /* the next event delivers it */ }
      void planPoke();
    }, Math.min(Math.max(due - Date.now(), 0) + 5000, 2 ** 31 - 1));
  }
  const off = personal.subscribe?.('me:spaces', () => later(30_000));
  later(delay);
  const entry = {
    refs: 1,
    release: () => {
      entry.refs -= 1;
      if (entry.refs > 0) return;
      stopped = true; clearTimer(syncTimer); clearTimer(pokeTimer); off?.(); running.delete(account.uuid);
    },
  };
  running.set(account.uuid, entry);
  return entry.release;
}
