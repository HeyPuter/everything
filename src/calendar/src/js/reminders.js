/**
 * Event reminders: shared config + a local notification scheduler.
 *
 * Reminders are stored on an event as `reminders` — an array of "minutes before
 * start". They apply to timed events only (an all-day event has no meaningful
 * minute offset from local midnight). The scheduler watches the store and fires
 * a browser Notification ahead of each upcoming occurrence.
 *
 * Only reminders whose fire time is still in the future are scheduled, so a
 * reload never replays past ones. The desired set is recomputed on every store
 * change and on a periodic tick, so edits, deletes, and new events stay in sync
 * within a rolling horizon.
 */
import { formatTimeRange } from './date-utils.js';

/** Largest supported reminder lead time. Bounds how far ahead the scheduler
 *  must expand occurrences, and caps stored values. */
export const MAX_REMINDER_MIN = 1440; // 1 day

export const REMINDER_PRESETS = [
  { min: 0, label: 'At time of event' },
  { min: 5, label: '5 minutes before' },
  { min: 10, label: '10 minutes before' },
  { min: 15, label: '15 minutes before' },
  { min: 30, label: '30 minutes before' },
  { min: 60, label: '1 hour before' },
  { min: 120, label: '2 hours before' },
  { min: MAX_REMINDER_MIN, label: '1 day before' },
];

const HORIZON_MS = 12 * 3_600_000; // only arm reminders firing within this window
const SCAN_INTERVAL_MS = 60_000;

/** Validate a reminders array: finite minutes in [0, MAX], deduped, sorted,
 *  capped to 5. Returns a fresh array (never shares the input). */
export function normalizeReminders(input) {
  if (!Array.isArray(input)) return [];
  const set = new Set();
  for (const v of input) {
    // Only a number, or a string holding one, can be a minute count. A
    // foreign backup's `null`, `false`, `''` or `[]` all coerce to 0 and
    // `true` to 1 — each a real reminder the user never set, firing a
    // notification at (or a minute before) every occurrence.
    if (typeof v !== 'number' && !(typeof v === 'string' && v.trim() !== '')) continue;
    const n = Math.round(Number(v));
    if (Number.isFinite(n) && n >= 0 && n <= MAX_REMINDER_MIN) set.add(n);
  }
  return [...set].sort((a, b) => a - b).slice(0, 5);
}

export function describeReminder(min) {
  const p = REMINDER_PRESETS.find((x) => x.min === min);
  if (p) return p.label;
  if (min <= 0) return 'At time of event';
  if (min % 1440 === 0) {
    const d = min / 1440;
    return `${d} day${d === 1 ? '' : 's'} before`;
  }
  if (min % 60 === 0) {
    const h = min / 60;
    return `${h} hour${h === 1 ? '' : 's'} before`;
  }
  return `${min} minutes before`;
}

/* ---- Browser Notification permission --------------------------------- */

export function notificationsSupported() {
  return typeof Notification !== 'undefined';
}

export function notificationPermission() {
  return notificationsSupported() ? Notification.permission : 'denied';
}

/** Request permission if still undecided; resolves to the resulting state.
 *  Must be called from a user gesture (e.g. adding a reminder). */
export async function ensureNotificationPermission() {
  if (!notificationsSupported()) return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/* ---- Scheduler -------------------------------------------------------- */

/** Expand with store.getEventsInRange first, so overrides share this logic. */
export function reminderEntries(events, now) {
  const entries = new Map();
  for (const ev of events) {
    if (ev.allDay || ev.declined || ev.end <= now || !Array.isArray(ev.reminders)) continue;
    for (const min of ev.reminders) {
      const key = `${ev.id}#${ev.start}#${min}`;
      entries.set(key, { fireAt: ev.start - min * 60_000, id: ev.id, min, event: ev });
    }
  }
  return entries;
}

export function createReminderScheduler({ store, now = () => Date.now(), isStored = () => false }) {
  const timers = new Map(); // key -> timeout id
  const fired = new Set(); // keys already fired this session
  let scanTimer = null;
  let unsub = null;
  let lastSyncAt = null; // previous tick's clock — null until the first sync
  let generation = 0;

  /**
   * Scan events near `t` and return:
   *  - `schedule`: reminders that should be armed now (fire time strictly ahead,
   *    within the horizon) — plus any that came DUE between the previous tick
   *    and now (see below);
   *  - `live`: every reminder key that still exists, regardless of timing — used
   *    to cancel timers only when their event/reminder actually goes away, never
   *    merely because a scan tick reached the fire time.
   */
  function scan(t, prevT) {
    const schedule = new Map();
    const live = new Set();
    const events = store.getEventsInRange(t - HORIZON_MS, t + HORIZON_MS + MAX_REMINDER_MIN * 60_000, {
      includeHidden: true,
    });
    for (const [key, item] of reminderEntries(events, t)) {
      live.add(key);
      const { fireAt } = item;
      const upcoming = fireAt > t && fireAt <= t + HORIZON_MS;
      // A fire time that passed between two ticks with no timer armed —
      // system sleep while it was still beyond the arming horizon — would
      // otherwise never fire at all, while an ARMED timer in the same sleep
      // replays late and is kept (fire() only suppresses ended events).
      // Treat both alike: what came due since the previous tick fires now,
      // unless the event is already over. `prevT` is null on the first sync
      // of a session, so a reload still never replays past reminders.
      const missed = prevT != null && fireAt > prevT && fireAt <= t;
      if (upcoming || missed) {
        schedule.set(key, item);
      }
    }
    return { schedule, live };
  }

  function sync() {
    if (!notificationsSupported() || Notification.permission !== 'granted') return;
    const t = now();
    // Track ticks only while notifications could actually fire, so reminders
    // that came due before permission existed are not replayed on grant.
    const prevT = lastSyncAt;
    lastSyncAt = t;

    // Prune `fired` keys whose event start is already older than the scan
    // window: such reminders can never be re-armed (their fireAt is well in the
    // past), so keeping them only leaks memory on a long-lived tab. Keys are
    // `${id}#${start}#${min}`; ids never contain '#', so start is second-to-last.
    for (const key of fired) {
      const parts = key.split('#');
      const startMs = Number(parts[parts.length - 2]);
      if (Number.isFinite(startMs) && startMs < t - HORIZON_MS) fired.delete(key);
    }

    const { schedule, live } = scan(t, prevT);

    // Drop timers whose reminder no longer exists (event deleted / edited / its
    // reminder removed). A timer is never cancelled just because time passed.
    for (const [key, id] of timers) {
      if (!live.has(key)) {
        clearTimeout(id);
        timers.delete(key);
      }
    }
    for (const [key, item] of schedule) {
      if (timers.has(key) || fired.has(key)) continue;
      const id = setTimeout(() => {
        timers.delete(key);
        fired.add(key);
        // A remote lookup is needed only when stored reminders are wired in.
        const stored = isStored(key);
        const current = generation;
        if (stored && typeof stored.then === 'function') {
          stored.catch(() => false).then((covered) => {
            if (!covered && current === generation) fire(item);
          });
        } else if (!stored) fire(item);
      }, Math.max(0, item.fireAt - t));
      timers.set(key, id);
    }
  }

  function fire({ id, min, event: scheduled }) {
    if (!notificationsSupported() || Notification.permission !== 'granted') return;
    // Re-resolve the event at fire time so an in-place edit that left the start
    // (and thus this timer) untouched — a renamed title, moved location, changed
    // end — still shows current content, and a deleted event fires nothing.
    const event = store.getEvent(id);
    if (!event || event.allDay || event.declined || !event.reminders.includes(min) || event.start !== scheduled.start) return;
    // System sleep suspends timeout clocks, so on wake every armed timer
    // replays at once, hours late. A reminder for an event that has already
    // ENDED is pure noise — the module contract ("a reload never replays past
    // ones") extends to the post-suspend backlog. A late reminder for an
    // event still upcoming or in progress remains useful and still shows.
    if (event.end <= now()) return;
    const hour12 = store.getSettings().hour12;
    const when = formatTimeRange(new Date(event.start), new Date(event.end), { hour12 });
    const parts = [when];
    if (event.location) parts.push(event.location);
    try {
      const n = new Notification(event.title || '(Untitled)', {
        body: `${leadText(min)}\n${parts.join(' · ')}`,
        tag: `${event.id}#${event.start}#${min}`,
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      /* Notification construction can throw on some platforms; ignore. */
    }
  }

  function start() {
    if (!notificationsSupported()) return;
    unsub = store.subscribe(sync);
    scanTimer = setInterval(sync, SCAN_INTERVAL_MS);
    sync();
  }

  function stop() {
    generation++;
    if (unsub) unsub();
    unsub = null;
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = null;
    for (const id of timers.values()) clearTimeout(id);
    timers.clear();
    fired.clear();
    lastSyncAt = null; // a restart is like a reload: never replay past ones
  }

  return { start, stop, sync };
}

export function leadText(min) {
  if (min <= 0) return 'Starting now';
  if (min >= MAX_REMINDER_MIN) return 'Starts in 1 day';
  // Match describeReminder's granularity: whole hours read as hours, anything
  // else (e.g. an imported 90-minute lead) reads as minutes — never rounded to
  // a wrong whole hour.
  if (min % 60 === 0) {
    const h = min / 60;
    return `Starts in ${h} hour${h === 1 ? '' : 's'}`;
  }
  return `Starts in ${min} minute${min === 1 ? '' : 's'}`;
}
