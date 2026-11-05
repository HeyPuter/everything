/** Deferred notifications, reconciled against the account's calendar. */
import { reminderEntries, leadText, MAX_REMINDER_MIN } from './reminders.js';
import { formatTimeRange } from './date-utils.js';
import { PUSH_CHANNEL, PUSH_OPTIONS } from './push.js';
import { isSignedIn } from './auth.js';
import { listAllEntries } from './store.js';

const PREFIX = 'cal:reminder:';
// Outside PREFIX's listing. A claim a crashed device left frees itself.
const CLAIM = 'cal:reminder-claim:';
const CLAIM_TTL = 120; // seconds
const HORIZON = 7 * 86400_000;
const MAX_WAITING = 50;
const MAX_CREATES = 15;
const MIN_AHEAD = 30_000;
const INTERVAL = 15 * 60_000;
const UNAVAILABLE = new Set(['events_disabled', 'forbidden', 'events_durable_requires_account']);
const CANCELLED = new Set(['events_schedule_not_found', 'events_schedule_sending']);

function hash(text) {
  let a = 0x811c9dc5;
  let b = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

const claimKey = (key, contentHash) => `${CLAIM}${hash(`${key}|${contentHash}`)}`;

export function reminderGroup(key) {
  return `reminder:${hash(key)}`;
}

function parse(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function content(item, hour12) {
  const ev = item.event;
  const zone = new Intl.DateTimeFormat('en', { timeZoneName: 'short' }).formatToParts(new Date(ev.start))
    .find((part) => part.type === 'timeZoneName').value;
  const when = `${formatTimeRange(new Date(ev.start), new Date(ev.end), { hour12 })} ${zone}`;
  const text = `${leadText(item.min)}\n${when}${ev.location ? ' · ' + ev.location : ''}`;
  return {
    title: Array.from((ev.title.trim() || '(Untitled)').replace(/[\r\n]+/g, ' ')).slice(0, 120).join(''),
    text: Array.from(text).slice(0, 240).join(''),
    // Epochs keep devices in different time zones from replacing each other.
    hash: hash(JSON.stringify([ev.title, ev.start, ev.end, ev.location, item.min, hour12])),
  };
}

export function createStoredReminders({
  store, kv, getPuter = () => typeof puter !== 'undefined' ? puter : null,
  signedIn = isSignedIn, now = () => Date.now(),
  refresh = () => store.load(),
  locks = typeof navigator !== 'undefined' ? navigator.locks : null,
}) {
  let unavailable = false;
  let stopped = false;
  let running = null;
  let timer = null;
  let retry = null;
  let debounce = null;
  let unsub = null;
  let loading = false;
  let again = false;
  // A due-now result has no schedule id, but must still suppress local replay.
  const recent = new Map();

  function usable() {
    const p = getPuter();
    return signedIn() && p && ['web', 'app'].includes(p.env) && p.notifications && !unavailable;
  }

  function failed(err) {
    console.warn('[calendar] stored reminders', err);
    const code = err && (err.code || err.error?.code);
    if (UNAVAILABLE.has(code)) unavailable = true;
    return code;
  }

  async function entries() {
    const rows = await listAllEntries(kv, PREFIX);
    return rows.map((row) => ({ ...parse(row.value), storageKey: row.key }))
      .filter((row) => typeof row.key === 'string' && typeof row.scheduleId === 'string' && Number.isFinite(row.sendAt))
      .sort((a, b) => a.scheduleId.localeCompare(b.scheduleId));
  }

  async function remove(row) {
    try {
      await getPuter().notifications.cancel(row.scheduleId);
    } catch (err) {
      if (!CANCELLED.has(err && err.code)) throw err;
    }
    await kv.del(row.storageKey);
    // So the same reminder, added back, can be stored again at once.
    await kv.del(claimKey(row.key, row.hash)).catch(() => {});
  }

  /**
   * A reminder whose words changed (title, place, end, clock format) keeps
   * its stored notification with the new text. A new time is a new key.
   */
  async function retext(row, item) {
    try {
      await getPuter().events.updateSchedule(row.scheduleId, { title: item.title, text: item.text });
    } catch (err) {
      if (CANCELLED.has(err && err.code)) return false;
      throw err;
    }
    await kv.set(row.storageKey, { key: row.key, scheduleId: row.scheduleId, sendAt: row.sendAt, hash: item.hash });
    return true;
  }

  async function reconcile() {
    if (!usable() || stopped) return;
    clearTimeout(retry);
    retry = null;
    // Reconcile the cloud calendar, not an offline snapshot or a stale copy
    // another device has since changed.
    loading = true;
    try { await refresh(); } finally { loading = false; }
    if (!usable() || stopped) return;
    const enabled = store.getSettings().storedReminders === true;
    const t = now();
    const rows = await entries();
    const events = enabled ? store.getEventsInRange(t - 86400_000, t + HORIZON + MAX_REMINDER_MIN * 60_000, { includeHidden: true }) : [];
    const all = reminderEntries(events, t);
    for (const key of recent.keys()) if (!all.has(key)) recent.delete(key);
    const desired = [...all].filter(([, item]) => item.fireAt > t && item.fireAt <= t + HORIZON)
      .sort((a, b) => a[1].fireAt - b[1].fireAt || a[0].localeCompare(b[0])).slice(0, MAX_WAITING);
    const wanted = new Map(desired.map(([key, item]) => [key, { ...item, ...content(item, store.getSettings().hour12) }]));
    const kept = new Set();
    let waiting = 0;
    for (const row of rows) {
      if (!usable()) return;
      const item = wanted.get(row.key);
      const live = all.get(row.key);
      // Keep sent ids until the event ends, for local timers waking from sleep.
      if (enabled && row.sendAt <= t && live && content(live, store.getSettings().hour12).hash === row.hash) {
        continue;
      }
      if (item && !kept.has(row.key) && (item.hash === row.hash
        || (row.sendAt > now() + MIN_AHEAD && await retext(row, item)))) {
        kept.add(row.key);
        waiting++;
      } else {
        // A failed cancel must keep its record and prevent a replacement.
        await remove(row);
      }
    }
    let created = 0;
    for (const [key, item] of wanted) {
      if (!usable() || stopped || kept.has(key) || item.fireAt < now() + MIN_AHEAD) continue;
      if (waiting >= MAX_WAITING) break;
      if (created >= MAX_CREATES) {
        // Deferred notifications share the 60/minute budget.
        retry = setTimeout(() => sync(), 60_000);
        break;
      }
      const target = `/?event=${encodeURIComponent(item.id)}`;
      // Imported ids can exceed notification limits; local reminders still work.
      if (target.length > 512 || new TextEncoder().encode(JSON.stringify({ eventId: item.id })).length > 1024) continue;
      // Two devices syncing at once: only the one that takes the claim from 0 to 1 stores it.
      const claim = claimKey(key, item.hash);
      const claimed = (await kv.incr(claim)) === 1;
      await kv.expire(claim, CLAIM_TTL).catch(() => {});
      if (!claimed) continue;
      created++;
      let result;
      try {
        result = await getPuter().notifications.notify({
          title: item.title, text: item.text, target, data: { eventId: item.id },
          channel: PUSH_CHANNEL, group: reminderGroup(key), sendAt: item.fireAt,
        });
      } catch (err) {
        await kv.del(claim).catch(() => {});
        throw err;
      }
      if (result && typeof result === 'object' && result.scheduleId) {
        // A separate entry per schedule keeps both ids if a claim expired mid-race.
        const storageKey = `${PREFIX}${hash(key)}:${result.scheduleId}`;
        const row = { key, scheduleId: result.scheduleId, sendAt: result.sendAt, hash: item.hash };
        try { await kv.set(storageKey, row); }
        catch (err) {
          await getPuter().notifications.cancel(result.scheduleId).catch(failed);
          await kv.del(claim).catch(() => {});
          throw err;
        }
        waiting++;
      } else {
        recent.set(key, now());
      }
    }
  }

  function sync() {
    if (running) {
      again = true;
      return running;
    }
    const work = locks
      ? locks.request('calendar:stored-reminders', { ifAvailable: true }, (lock) => lock ? reconcile() : undefined)
      : reconcile();
    running = Promise.resolve(work).catch(failed).finally(() => {
      running = null;
      if (again) {
        again = false;
        changed();
      }
    });
    return running;
  }

  function changed() {
    if (loading || stopped) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => sync(), 3000);
  }

  function start() {
    if (unsub) return;
    stopped = false;
    unsub = store.subscribe(changed);
    timer = setInterval(() => sync(), INTERVAL);
    sync();
  }

  function stop() {
    stopped = true;
    if (unsub) unsub();
    unsub = null;
    clearTimeout(debounce);
    clearTimeout(retry);
    clearInterval(timer);
  }

  /** Only suppress reminders actually stored, including those in another tab. */
  async function handles(key) {
    if (!usable() || stopped || store.getSettings().storedReminders !== true) return false;
    if (document.visibilityState === 'visible' && document.hasFocus()) return false;
    try {
      if (await getPuter().notifications.status(PUSH_OPTIONS) !== 'on') return false;
      if (recent.has(key)) return true;
      const rows = await kv.list(`${PREFIX}${hash(key)}:*`, true);
      return rows.some((row) => parse(row.value)?.key === key);
    } catch (err) {
      failed(err);
      return false;
    }
  }

  return { start, stop, sync, handles };
}
