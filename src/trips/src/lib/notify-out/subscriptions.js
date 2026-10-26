// Persistent event subscriptions that run the published `tripsNotify` handler as this user: one on
// `me:notify:sched` and one per watched trip on its `sig` (own KV for owned trips, the read handle otherwise).
import { addDays } from '../../shared/dates.js';
import { DomainError } from '../../shared/errors.js';
import { HANDLER_NAME, LIMITS, CATEGORIES, PUSH_CHANNELS } from './model.js';

const ENDED_GRACE_DAYS = 7;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const backgroundAvailable = (puter) => typeof puter?.events?.onPersistent === 'function' && typeof puter?.events?.list === 'function';

/** True when some channel is on for an activity category other than reminders. */
export function wantsActivity(prefs) {
  const on = [...PUSH_CHANNELS, 'email'].filter((name) => prefs.channels[name]?.on);
  return CATEGORIES.some((category) => category !== 'reminders' && prefs.events[category].some((name) => on.includes(name)));
}

/**
 * Trips to watch, in order, with why others are not: `{watch: [entry], reasons: Map<spaceId, reason>}` where reason
 * is `off`, `reminders`, `ended`, `noAccess` or `limit`.
 */
export function tripsToWatch(entries, prefs, today) {
  const reasons = new Map();
  const candidates = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.ref?.k !== 'trip') continue;
    const id = entry.ref.s;
    const mode = prefs.trips[id] ?? 'all';
    if (mode !== 'all') { reasons.set(id, mode); continue; }
    const last = entry.end ?? entry.start;
    if (last && addDays(last, ENDED_GRACE_DAYS) < today) { reasons.set(id, 'ended'); continue; }
    if (entry.role !== 'owner' && !entry.handles?.read) { reasons.set(id, 'noAccess'); continue; }
    candidates.push(entry);
  }
  // Current and upcoming trips first (soonest start), then undated ones by last opened.
  candidates.sort((a, b) => (a.start && b.start ? a.start.localeCompare(b.start) : a.start ? -1 : b.start ? 1 : (b.opened ?? 0) - (a.opened ?? 0)));
  const watch = candidates.slice(0, LIMITS.trips);
  for (const entry of candidates.slice(LIMITS.trips)) reasons.set(entry.ref.s, 'limit');
  return { watch, reasons };
}

/** The subscriptions this device wants: `[{key, subject, match(subject), context}]`. */
export function desiredSubscriptions({ entries, prefs, uid, origin, today, appUid }) {
  if (!prefs.on || typeof appUid !== 'string' || !appUid) return { list: [], reasons: new Map() };
  const sched = `kv:${appUid}:me:notify:sched`;
  const list = [{ key: 'sched', subject: sched, match: (subject) => subject === sched, context: { v: 1, k: 'sched', u: uid, o: origin } }];
  const { watch, reasons } = wantsActivity(prefs) ? tripsToWatch(entries, prefs, today) : { watch: [], reasons: new Map() };
  for (const entry of watch) {
    const { s, w } = entry.ref;
    const own = entry.role === 'owner';
    const handle = own ? null : entry.handles.read;
    const subject = own ? `kv:${appUid}:shared:${s}:sig` : `kv:${handle}:sig`;
    list.push({
      key: s, subject, match: (value) => value === subject,
      context: { v: 1, k: 'trip', u: uid, o: origin, s, w, ...(handle ? { h: handle } : {}) },
    });
  }
  return { list, reasons };
}

async function listAll(puter) {
  const result = await puter.events.list();
  const items = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : [];
  return items.filter((sub) => plain(sub) && sub.handlerName === HANDLER_NAME && typeof sub.subId === 'string');
}

/** Asks once for `events:background`; throws `consent_denied` when refused. */
export async function ensureBackgroundConsent(puter) {
  if (typeof puter?.perms?.request !== 'function') return;
  let granted;
  try { granted = await puter.perms.request('backgroundEvents'); } catch { granted = false; }
  if (granted === false) throw new DomainError('consent_denied', 403);
}

/**
 * Makes this account's handler subscriptions match `desired`: keeps one healthy subscription per subject, drops
 * duplicates, revoked ones and ones no longer wanted, and creates the missing ones.
 * Resolves `{watched: Set<key>, limit: boolean}`.
 */
export async function reconcileSubscriptions(puter, desired) {
  const existing = await listAll(puter);
  const kept = new Map();
  const drop = [];
  for (const sub of existing) {
    const want = desired.find((item) => item.match(String(sub.subject ?? '')));
    // `permission_revoked` never resumes; other suspensions resume when the handler is published again or credit returns.
    if (!want || kept.has(want.key) || sub.suspendedReason === 'permission_revoked') drop.push(sub);
    else kept.set(want.key, sub);
  }
  for (const sub of drop) await puter.events.unsubscribe(sub.subId).catch(() => {});
  const watched = new Set(kept.keys());
  let limit = false;
  for (const item of desired) {
    if (watched.has(item.key)) continue;
    try {
      await puter.events.onPersistent({ subject: item.subject, handlerName: HANDLER_NAME, targets: ['worker'], includeValue: true, context: item.context });
      watched.add(item.key);
    } catch (error) {
      if (error?.code === 'events_subscription_limit') { limit = true; break; }
      if (error?.code === 'subject_does_not_exist') continue;
      throw error;
    }
  }
  return { watched, limit };
}

/** Ends every handler subscription this account holds for Trips. */
export async function removeSubscriptions(puter) {
  if (!backgroundAvailable(puter)) return 0;
  const existing = await listAll(puter);
  for (const sub of existing) await puter.events.unsubscribe(sub.subId).catch(() => {});
  return existing.length;
}
