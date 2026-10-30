/**
 * Data layer for the calendar.
 *
 * Persistence is delegated to a key-value backend that matches the shape of
 * `puter.kv` (set / get / del / list). The backend is injected so the store
 * can be exercised in tests with a plain in-memory stand-in.
 *
 * Events are stored one key per event under the `cal:evt:` prefix; app
 * settings live under a single `cal:settings` key. The store keeps an
 * in-memory cache and notifies subscribers whenever data changes.
 *
 * A recurring event is a single stored "series master" carrying a `recurrence`
 * rule plus inline `exdates` (cancelled occurrences) and `overrides` (per-
 * occurrence edits). Views never see the master directly: `getEventsInRange`
 * expands it into individual occurrence objects. See `recurrence.js`.
 */
import { DEFAULT_COLOR, isValidColor, sanitizeCategoryNames } from './colors.js';
import { normalizeReminders } from './reminders.js';
import {
  normalizeRecurrence,
  expandOccurrences,
  materializeOccurrence,
  countScheduledBefore,
  isScheduledOccurrence,
} from './recurrence.js';
import { startOfDay, endOfDay, addDays, MS_PER_DAY } from './date-utils.js';
import { getHolidaysInRange, resolveHolidayCountry } from './holidays.js';
import { getClockChangesInRange, browserZone } from './dst.js';

const EVENT_PREFIX = 'cal:evt:';
const TASK_PREFIX = 'cal:task:';
const SETTINGS_KEY = 'cal:settings';
const DEFAULT_DURATION_MS = 60 * 60_000;
const DAY_MS = 86_400_000;
const OCC_SEP = '::';
// How far past today a REPEATING out-of-office block's auto-decline sweep
// looks (see applyOutOfOffice). A rule can be endless, so the sweep needs a
// bound; a year covers anything on the calendar a person plans around, and
// keeps the sweep proportional to the occurrences it will actually find.
const OOO_SWEEP_HORIZON_MS = 365 * DAY_MS;

// A 32-bit string hash (FNV-1a). Used only to fingerprint the calendar for
// change detection — never for identity or storage.
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Import persistence pacing (see importEvents): puter.kv 429s when a big
// import fires one request per event, so events are written in batched
// `kv.set([{ key, value }, …])` calls, sent one at a time, with exponential
// backoff on a rate limit. The chunk size is deliberately modest: the docs
// publish no batch cap, and a chunk is also the all-or-nothing unit of
// failure/retry and the progress-callback granularity.
const IMPORT_CHUNK = 25;
const IMPORT_MAX_ATTEMPTS = 6;
const IMPORT_BACKOFF_MS = 500;
const IMPORT_BACKOFF_CAP_MS = 8_000;

/**
 * True for puter.kv's rate-limit rejection. It rejects with a plain object —
 * `{ error: 'Too many requests.', message: '…', code: 'too_many_requests' }` —
 * not an Error, so check shape-first with a message fallback.
 */
function isRateLimitError(err) {
  if (!err) return false;
  const code = err.code ?? (err.error && err.error.code) ?? err.status;
  if (code === 'too_many_requests' || code === 429) return true;
  // `error` can carry the text alone (no code/message on some rejections).
  const msg =
    typeof err === 'string' ? err : err.message || (typeof err.error === 'string' ? err.error : '');
  return /too many requests|rate.?limit/i.test(String(msg));
}

// puter.kv.list SILENTLY truncates large result sets — observed live: 2,139
// stored keys, one flat `list('cal:evt:*')` deterministically returned 1,085,
// with no error, marker, or cursor (same count with and without values).
// Sharded queries (`cal:evt:0*` … `cal:evt:f*`) each returned complete
// results. So a flat list cannot be trusted past roughly a thousand entries /
// a megabyte of values; when a result even *looks* big enough to have been
// cut, re-list the namespace sharded by the next id character and merge.
// Every id from uid() starts with a lowercase hex char (randomUUID, or the
// 'e-' fallback), so 16 hex shards cover the namespace.
const LIST_SHARD_CHARS = '0123456789abcdef';
const LIST_SUSPECT_COUNT = 500;
const LIST_SUSPECT_BYTES = 512 * 1024;

// Measure real UTF-8 bytes, not UTF-16 code units: `.length` undercounts
// non-ASCII text up to 3× (CJK), which could put the effective guard ABOVE
// the server's cut point and let a truncated flat list pass as trustworthy.
// The fallback overcounts (never undercounts), erring toward sharding.
const utf8 = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const utf8Bytes = (s) => (utf8 ? utf8.encode(s).length : s.length * 3);

/** Truncation is undetectable from the response, so err on paranoia: treat a
 *  result as possibly-cut when it is large by count OR by payload bytes (the
 *  observed cut point scales with value size, not just entry count).
 *  Exported for the offline snapshot (offline-store.js), which must not treat
 *  a possibly-cut list as the complete truth about a namespace. */
export function looksTruncated(entries) {
  if (entries.length >= LIST_SUSPECT_COUNT) return true;
  let bytes = 0;
  for (const e of entries) {
    const v = e && e.value;
    bytes += utf8Bytes(typeof v === 'string' ? v : v ? JSON.stringify(v) : '');
    if (bytes >= LIST_SUSPECT_BYTES) return true;
  }
  return false;
}

/**
 * List EVERY entry under a key prefix, working around the silent truncation
 * above. Fast path: one flat request, trusted when the result is small.
 * Otherwise fan out one sub-list per hex character and recurse (bounded), then
 * merge by key. Small calendars keep their single-request boot; only data sets
 * big enough to be at risk pay for the fan-out.
 */
async function listAllEntries(kv, prefix, depth = 0) {
  const flat = (await kv.list(`${prefix}*`, true)) || [];
  if (depth >= 3 || !looksTruncated(flat)) return flat;
  const shards = await Promise.all(
    [...LIST_SHARD_CHARS].map((c) => listAllEntries(kv, prefix + c, depth + 1)),
  );
  const byKey = new Map();
  for (const e of flat) if (e && typeof e.key === 'string') byKey.set(e.key, e);
  for (const shard of shards) {
    for (const e of shard) if (e && typeof e.key === 'string') byKey.set(e.key, e);
  }
  return [...byKey.values()];
}

export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'system', // 'system' | 'light' | 'dark'
  weekStartsOn: 0, // 0 = Sunday, 1 = Monday
  hour12: true,
  // ISO 8601 week numbers on the month grid, the sidebar mini-calendar, and
  // the week-view title. Off by default so the 7-column layout stays as it is.
  showWeekNumbers: false,
  defaultView: 'month', // 'month' | 'week' | 'day' | 'agenda'
  hiddenColors: [],
  // Renamed sidebar categories: palette key -> the user's own name, holding
  // only the ones they renamed (see sanitizeCategoryNames).
  categoryNames: {},
  // The sidebar's two folding sections, shut (see renderSidebar). View
  // preferences, but synced ones: it is the same person's sidebar everywhere.
  categoriesCollapsed: false,
  bookingLinksCollapsed: false,
  secondaryTz: '', // IANA id shown as a secondary time zone, or '' for off
  // Public holidays: a country id (see holidays.js), 'auto' to take the
  // browser's word for where the user is, or '' for off.
  holidayCountry: 'auto',
  // Mark the days the clocks go forward or back (see dst.js). Derived from
  // the browser's own zone, so it is self-silencing where clocks never move.
  clockChanges: true,
  // The name guests see on booking pages and in booking emails, or '' to show
  // the account's username (the default; see displayName in booking.js).
  bookingName: '',
  // Which mail-detected invitations (see mail-intake.js) get added to the
  // calendar automatically vs. waiting in the tray for a click. Only prior
  // interaction ever counts as "known" — there is no "anyone" setting.
  mailInvites: 'known', // 'known' | 'never'
  mailInvitesCollapsed: false,
  // An unknown sender's invitation is hidden entirely by default (see
  // mail-intake.js's isKnown). This surfaces it in the tray instead, labelled
  // "Unknown sender".
  mailInvitesShowUnknown: false,
});

/** Settings are one KV value every device writes; a foreign or hand-edited
 *  copy may hold anything under this key. Only a string is a name. */
function sanitizeBookingName(value) {
  return typeof value === 'string' ? value : '';
}

const MAIL_INVITES_MODES = new Set(['known', 'never']);
/** Same reasoning as `sanitizeBookingName`: only a known mode survives. */
function sanitizeMailInvites(value) {
  return MAIL_INVITES_MODES.has(value) ? value : DEFAULT_SETTINGS.mailInvites;
}

/** Only a real boolean survives — a foreign or hand-edited copy could hold
 *  anything under this key. */
function sanitizeShowUnknown(value) {
  return value === true;
}

/** Same as `sanitizeShowUnknown`: only a real boolean `true` turns this on. */
function sanitizeShowWeekNumbers(value) {
  return value === true;
}

function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'e-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** The write stamp to re-normalize a stored record under: its own `updatedAt`
 *  when that is a number, else now. A foreign or hand-edited record's string
 *  stamp must not pass through — normalizeEvent copies it onto createdAt and
 *  updatedAt as-is, and every later date comparison against them is garbage. */
function stampOf(value) {
  return Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now();
}

/** Values from `puter.kv` may already be parsed objects or JSON strings. */
function coerceValue(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

/* ---- RSVP model ------------------------------------------------------- */

export const GUEST_STATUSES = ['accepted', 'declined', 'tentative', 'needs-action'];
const GUEST_STATUS_SET = new Set(GUEST_STATUSES);
const MAX_GUESTS = 200; // sanity cap for imported monsters

/** Light shape check — reject garbage without pretending to be an RFC parser. */
function normalizeEmail(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254 ? s : '';
}

/** `organizer` marks where an invitation came from; null for your own events. */
function normalizeOrganizer(input) {
  if (!input || typeof input !== 'object') return null;
  const email = normalizeEmail(input.email);
  if (!email) return null;
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 200) : '';
  return name ? { email, name } : { email };
}

/** Guests deduped by email, each with a validated response status. A guest
 *  who answered via an RSVP link also carries `rsvpAt` (when — the merge
 *  tiebreaker in applyRsvpResponses) and optionally a `comment` for the host. */
function normalizeGuests(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const g of input) {
    if (!g || typeof g !== 'object') continue;
    const email = normalizeEmail(g.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const name = typeof g.name === 'string' ? g.name.trim().slice(0, 200) : '';
    const status = GUEST_STATUS_SET.has(g.status) ? g.status : 'needs-action';
    const entry = name ? { email, name, status } : { email, status };
    if (Number.isFinite(g.rsvpAt)) entry.rsvpAt = Math.round(g.rsvpAt);
    const comment = typeof g.comment === 'string' ? g.comment.trim().slice(0, 500) : '';
    if (comment) entry.comment = comment;
    out.push(entry);
    if (out.length >= MAX_GUESTS) break;
  }
  return out;
}

/**
 * `booking` marks an event created from the user's booking page (see
 * booking.js): who booked, through which link. Its `id` is the worker's
 * booking id — also this event's own id, which is what makes applying a pulled
 * booking idempotent across devices. Null (and absent from the stored object)
 * for every other event, so existing events and code paths are unaffected.
 */
function normalizeBookingRef(input) {
  if (!input || typeof input !== 'object') return null;
  const id = typeof input.id === 'string' && /^[a-z0-9]{6,64}$/.test(input.id) ? input.id : '';
  if (!id) return null;
  const out = { id };
  if (typeof input.pageId === 'string' && input.pageId) out.pageId = input.pageId.slice(0, 64);
  if (typeof input.pageTitle === 'string' && input.pageTitle.trim()) {
    out.pageTitle = input.pageTitle.trim().slice(0, 200);
  }
  const email = normalizeEmail(input.email);
  if (email) out.email = email;
  if (typeof input.name === 'string' && input.name.trim()) out.name = input.name.trim().slice(0, 200);
  return out;
}

/**
 * A meeting link attached to an event (minted from the Puter Meetings app —
 * see meetings.js). `url` is what everyone opens to join; `code` is the
 * meeting room's own persistent code, kept so the link stays manageable
 * (recognized, resolved, released) without parsing the URL back apart. Null
 * (and absent from the stored object) for every other event, so existing
 * events and code paths are unaffected.
 */
function normalizeMeetingRef(input) {
  if (!input || typeof input !== 'object') return null;
  const url = typeof input.url === 'string' ? input.url.trim().slice(0, 500) : '';
  if (!/^https?:\/\//i.test(url)) return null;
  const out = { url };
  if (typeof input.code === 'string' && input.code.trim()) {
    out.code = input.code.trim().slice(0, 100);
  }
  return out;
}

/**
 * `invite` marks an event that arrived via a detected mail invitation (see
 * mail-intake.js): the iTIP identity needed to decide whether a later message
 * is newer (`uid`/`seq`/`stamp`), who sent it (`from`), and which attendee
 * address the invitation actually reached us by (`attendee` — RFC 5546 says a
 * REPLY names exactly that one; a client's own address, not the organizer's,
 * decides which guest row an update or a reply-by-mail applies to). Null (and
 * absent from the stored object) for every other event, so existing events
 * and code paths are unaffected.
 */
function normalizeInviteRef(input) {
  if (!input || typeof input !== 'object') return null;
  const uid = typeof input.uid === 'string' ? input.uid.trim().slice(0, 255) : '';
  if (!uid) return null;
  const out = {
    uid,
    seq: Number.isFinite(input.seq) ? Math.max(0, Math.floor(input.seq)) : 0,
    stamp: Number.isFinite(input.stamp) ? Math.round(input.stamp) : 0,
  };
  const from = normalizeEmail(input.from);
  if (from) out.from = from;
  const attendee = normalizeEmail(input.attendee);
  if (attendee) out.attendee = attendee;
  return out;
}

/** Keep only the known, well-typed fields of a per-occurrence override patch. */
function sanitizeOverride(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  if (typeof input.title === 'string') out.title = input.title.slice(0, 500);
  if (typeof input.description === 'string') out.description = input.description.slice(0, 5000);
  if (typeof input.location === 'string') out.location = input.location.slice(0, 500);
  if (typeof input.allDay === 'boolean') out.allDay = input.allDay;
  if (isValidColor(input.color)) out.color = input.color;
  if (Number.isFinite(input.start)) out.start = Math.round(input.start);
  if (Number.isFinite(input.end)) out.end = Math.round(input.end);
  if (Array.isArray(input.reminders)) out.reminders = normalizeReminders(input.reminders);
  return out;
}

/**
 * Validate + fill defaults for an event. Always returns a well-formed object
 * with numeric `start`/`end` (end strictly after start) so views never crash
 * on malformed persisted data. Recurring events additionally carry a validated
 * `recurrence` rule plus `exdates` / `overrides`.
 */
export function normalizeEvent(input = {}, now = Date.now()) {
  const start = Number.isFinite(input.start) ? Math.round(input.start) : now;
  let end = Number.isFinite(input.end) ? Math.round(input.end) : start + DEFAULT_DURATION_MS;
  const allDay = Boolean(input.allDay);
  // Guarantee positive duration; an all-day event covers at least its own
  // day. Its own CALENDAR day: a fixed 24h span overshoots into the next day
  // on a 23-hour spring-forward day (every other all-day span here — import,
  // occurrence building, splits — already uses calendar-day math). The max()
  // covers a start already at the last millisecond of its day.
  if (end <= start) {
    end = allDay
      ? Math.max(endOfDay(new Date(start)).getTime(), start + 1)
      : start + DEFAULT_DURATION_MS;
  } else if (allDay) {
    // An all-day end is the last instant of its last day (the editor writes
    // endOfDay). Other writers — the app-to-app API, a foreign JSON backup —
    // naturally send the ISO-style EXCLUSIVE end, midnight after the last
    // day, and that instant belongs to the NEXT day: the month view then
    // drew the event across two days and the .ics export wrote a two-day
    // DTEND. Normalize to the last instant of the day the end really falls
    // in, so an end at midnight means "through the day before". Canonical
    // input is unchanged; a mid-day end still covers that day.
    end = Math.max(endOfDay(new Date(end - 1)).getTime(), start + 1);
  }

  const base = {
    id: typeof input.id === 'string' && input.id ? input.id : uid(),
    title: typeof input.title === 'string' ? input.title.slice(0, 500) : '',
    description: typeof input.description === 'string' ? input.description.slice(0, 5000) : '',
    location: typeof input.location === 'string' ? input.location.slice(0, 500) : '',
    start,
    end,
    allDay,
    color: isValidColor(input.color) ? input.color : DEFAULT_COLOR,
    reminders: normalizeReminders(input.reminders),
    // An "out of office" block (marks you away); `declined` dims an event that
    // an out-of-office period overlaps. Both default false, so existing events
    // and every code path that ignores them are unaffected.
    ooo: Boolean(input.ooo),
    declined: Boolean(input.declined),
    // RSVP: who invited (null = your own event) and per-guest response status.
    // Both default empty, so existing events and code paths are unaffected.
    organizer: normalizeOrganizer(input.organizer),
    guests: normalizeGuests(input.guests),
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : now,
    updatedAt: now,
  };

  // Only present on events created from the booking page — added rather than
  // defaulted so every existing event's stored shape stays byte-identical.
  const booking = normalizeBookingRef(input.booking);
  if (booking) base.booking = booking;

  // A meeting link, when one was attached — added, not defaulted, for the
  // same byte-identical reason as `booking` above.
  const meeting = normalizeMeetingRef(input.meeting);
  if (meeting) base.meeting = meeting;

  // Mail-invitation provenance, when this event arrived that way — same
  // byte-identical reasoning as `booking`/`meeting` above.
  const invite = normalizeInviteRef(input.invite);
  if (invite) base.invite = invite;

  const recurrence = normalizeRecurrence(input.recurrence, start);
  if (recurrence) {
    base.recurrence = recurrence;
    base.exdates = Array.isArray(input.exdates)
      ? [...new Set(input.exdates.filter(Number.isFinite).map(Math.round))].sort((a, b) => a - b)
      : [];
    base.overrides = {};
    const ov = input.overrides && typeof input.overrides === 'object' ? input.overrides : {};
    for (const [key, val] of Object.entries(ov)) {
      const rid = Number(key);
      if (!Number.isFinite(rid)) continue;
      const clean = sanitizeOverride(val);
      if (clean) base.overrides[rid] = clean;
    }
  }

  return base;
}

/** True when `event` intersects the half-open range [from, to). */
export function eventInRange(event, from, to) {
  return event.start < to && event.end > from;
}

/**
 * Validate + fill defaults for a task. Tasks are stored and expanded entirely
 * separately from events (own KV prefix, own cache) so nothing here can affect
 * event behavior. A task has a single `due` instant; `allDay` tasks are snapped
 * to the start of their day so they render on the right calendar day.
 */
export function normalizeTask(input = {}, now = Date.now()) {
  const allDay = Boolean(input.allDay);
  let due = Number.isFinite(input.due) ? Math.round(input.due) : now;
  if (allDay) due = startOfDay(new Date(due)).getTime();
  return {
    id: typeof input.id === 'string' && input.id ? input.id : uid(),
    title: typeof input.title === 'string' ? input.title.slice(0, 500) : '',
    notes: typeof input.notes === 'string' ? input.notes.slice(0, 5000) : '',
    due,
    allDay,
    done: Boolean(input.done),
    color: isValidColor(input.color) ? input.color : DEFAULT_COLOR,
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : now,
    updatedAt: now,
    isTask: true,
  };
}

/** Deep-equal two recurrence rules, anchored at `startMs`. */
function rulesEqual(a, b, startMs) {
  return (
    JSON.stringify(normalizeRecurrence(a, startMs)) ===
    JSON.stringify(normalizeRecurrence(b, startMs))
  );
}

/** Equal recurrence PATTERN (freq/interval/byWeekday/monthlyMode), ignoring
 *  the end condition (count/until) — used when splitting a series. */
function patternEqual(a, b, startMs) {
  const na = normalizeRecurrence(a, startMs);
  const nb = normalizeRecurrence(b, startMs);
  if (!na || !nb) return na === nb;
  return (
    na.freq === nb.freq &&
    na.interval === nb.interval &&
    JSON.stringify(na.byWeekday) === JSON.stringify(nb.byWeekday) &&
    na.monthlyMode === nb.monthlyMode &&
    na.monthlyNth === nb.monthlyNth &&
    na.wkst === nb.wkst
  );
}

/**
 * Apply an occurrence's edited time-of-day + duration onto an anchor date. For
 * series / future edits we keep the occurrence's DATE fixed (the recurrence
 * pattern owns the dates) and only carry the time and length across.
 */
function reproject(anchorMs, editStartMs, editEndMs, allDay) {
  if (allDay) {
    const startD = startOfDay(new Date(anchorMs));
    const days = Math.max(1, Math.round((editEndMs - editStartMs) / MS_PER_DAY));
    return { start: startD.getTime(), end: endOfDay(addDays(startD, days - 1)).getTime() };
  }
  const d = new Date(anchorMs);
  const t = new Date(editStartMs);
  // Carry the edit's hour + minute onto the anchor's DATE, but KEEP the anchor's
  // own seconds/ms. The time input only offers hour+minute, so zeroing seconds
  // here would shift a series whose start carries sub-minute precision (only
  // reachable via an ICS import with a DTSTART like `T090030`) by up to 59s on a
  // content-only edit — which the `timeChanged`/`shifted` checks then read as a
  // real time move, silently clearing the series' exceptions. For an in-app
  // event (always zero seconds) this is identical to the old `…, 0, 0`.
  d.setHours(t.getHours(), t.getMinutes(), d.getSeconds(), d.getMilliseconds());
  const start = d.getTime();
  const dur = Math.max(60_000, editEndMs - editStartMs);
  return { start, end: start + dur };
}

export function createStore(backend) {
  const events = new Map();
  const tasks = new Map();
  let settings = { ...DEFAULT_SETTINGS };
  const listeners = new Set();
  let loaded = false;

  // Every write bumps this (see the kv wrapper below); load() uses it to tell
  // whether a mutation interleaved with its reads. Writes still on the wire
  // are also tracked, so a load() can wait for them: a list that runs while a
  // save is in flight may answer from before the save, and the
  // clear-and-repopulate would blink the saved event out of memory.
  let mutationCount = 0;
  const inFlight = new Set();
  const track = (promise) => {
    const p = Promise.resolve(promise);
    inFlight.add(p);
    p.finally(() => inFlight.delete(p)).catch(() => {});
    return promise;
  };
  const kv = {
    get: (...args) => backend.get(...args),
    list: (...args) => backend.list(...args),
    set: (...args) => {
      mutationCount += 1;
      return track(backend.set(...args));
    },
    del: (...args) => {
      mutationCount += 1;
      return track(backend.del(...args));
    },
  };

  /** Resolve once every write that is currently on the wire has settled —
   *  bounded, so a write the network never answers cannot hold a load()
   *  hostage (after that the load proceeds and mutationCount still guards
   *  anything that lands mid-read). */
  async function writesSettled(maxWaitMs = 10_000) {
    const deadline = Date.now() + maxWaitMs;
    while (inFlight.size && Date.now() < deadline) {
      const pending = [...inFlight];
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now()))),
      ]);
    }
  }

  function emit() {
    for (const fn of listeners) fn();
  }

  /**
   * Await a single-entry write and, if the cloud refuses it, put memory back
   * the way it was and re-emit. Every mutator below updates memory and emits
   * BEFORE awaiting the network, so the UI never waits on a round trip — but a
   * rejected write then left the screen showing a change the cloud never
   * took: a "Could not save" toast over an event that still looked saved, a
   * "Could not delete" toast over an event that had already vanished (only to
   * come back on the next load, looking like a resurrection). Reverting makes
   * the toast and the screen agree. Only when `map` still holds exactly what
   * this write put there: a later write to the same id has its own outcome to
   * report and must not be clobbered by an earlier one's failure.
   */
  async function writeOrRevert(map, id, expected, prev, write) {
    try {
      return await write();
    } catch (err) {
      if (map.get(id) === expected) {
        if (prev) map.set(id, prev);
        else map.delete(id);
        emit();
      }
      throw err;
    }
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  async function load() {
    // Re-read when a write landed while the lists were in flight: those lists
    // predate exactly the entries just touched, and the clear-and-repopulate
    // below would blink the fresh write out of memory until the NEXT load
    // (the cloud copy is safe — only what the user is looking at regressed).
    // Reachable from the API server's freshness re-reads and the reconnect
    // refresh, both of which can overlap a save. Bounded: after a few tries
    // under sustained writes, the freshest snapshot wins, which is no worse
    // than the old behavior with a far narrower window.
    let rawEvents;
    let rawTasks;
    let rawSettings;
    for (let attempt = 0; attempt < 3; attempt++) {
      // A write that STARTED before this load and lands after its lists is
      // invisible to the counter below — let the wire clear first.
      await writesSettled();
      const before = mutationCount;
      [rawEvents, rawTasks, rawSettings] = await Promise.all([
        listAllEntries(kv, EVENT_PREFIX),
        listAllEntries(kv, TASK_PREFIX),
        kv.get(SETTINGS_KEY),
      ]);
      if (mutationCount === before) break;
    }

    events.clear();
    for (const entry of rawEvents || []) {
      const value = coerceValue(entry && entry.value);
      if (!value || typeof value !== 'object') continue;
      const ev = normalizeEvent(value, stampOf(value));
      events.set(ev.id, ev);
    }

    tasks.clear();
    for (const entry of rawTasks || []) {
      const value = coerceValue(entry && entry.value);
      if (!value || typeof value !== 'object') continue;
      const t = normalizeTask(value, stampOf(value));
      tasks.set(t.id, t);
    }

    const parsedSettings = coerceValue(rawSettings);
    settings = { ...DEFAULT_SETTINGS, ...(parsedSettings || {}) };
    if (!Array.isArray(settings.hiddenColors)) settings.hiddenColors = [];
    settings.bookingName = sanitizeBookingName(settings.bookingName);
    settings.mailInvites = sanitizeMailInvites(settings.mailInvites);
    settings.mailInvitesShowUnknown = sanitizeShowUnknown(settings.mailInvitesShowUnknown);
    settings.showWeekNumbers = sanitizeShowWeekNumbers(settings.showWeekNumbers);
    // Always a fresh object, so the frozen default's `{}` can never be
    // reached (let alone mutated) through the live settings map.
    settings.categoryNames = sanitizeCategoryNames(settings.categoryNames);

    loaded = true;
    emit();
    return { events: getAllEvents(), settings: getSettings() };
  }

  /**
   * A fingerprint of the events themselves — `null` until the calendar has been
   * read from the cloud at least once.
   *
   * This exists for the app-to-app API, which must tell another app when the
   * calendar *changed*. Subscribing to `emit()` cannot answer that: the store
   * also emits for a re-read that found nothing new, and for things the API
   * does not serve at all, such as settings. Comparing two fingerprints answers
   * it exactly, and cannot be defeated by a future mutation path forgetting to
   * announce itself.
   *
   * Events only, to match what the API exposes; tasks and settings are the
   * calendar's own business. Built from each event's id and `updatedAt` —
   * normalizeEvent stamps the latter on every write, including the override and
   * exdate edits behind a single occurrence — combined additively so the result
   * does not depend on Map order, which a reload rebuilds from whatever order
   * the cloud listed the keys in.
   */
  function revision() {
    if (!loaded) return null;
    let sum = 0;
    for (const ev of events.values()) {
      sum = (sum + hashString(`${ev.id}:${ev.updatedAt}`)) >>> 0;
    }
    return `${events.size}:${sum}`;
  }

  function getAllEvents() {
    return [...events.values()];
  }

  /**
   * Look up an event by id. Occurrence ids (`<seriesId>::<recurrenceId>`) are
   * resolved to a materialized occurrence so views can treat them like any
   * other event.
   */
  function getEvent(id) {
    if (typeof id === 'string' && id.includes(OCC_SEP)) {
      const sep = id.indexOf(OCC_SEP);
      const master = events.get(id.slice(0, sep));
      const ridStr = id.slice(sep + OCC_SEP.length).trim();
      const rid = ridStr ? Number(ridStr) : NaN;
      // Vouch only for occurrences the series actually shows: an off-pattern
      // or out-of-bounds rid (Number('') is 0!) must read as "no such event",
      // not materialize a phantom no view renders — and a cancelled (exdated)
      // occurrence doesn't exist either.
      if (
        master &&
        master.recurrence &&
        Number.isFinite(rid) &&
        isScheduledOccurrence(master, rid) &&
        !(master.exdates || []).includes(rid)
      ) {
        return materializeOccurrence(master, rid);
      }
      return null;
    }
    return events.get(id) || null;
  }

  /**
   * Events (and expanded occurrences) intersecting [from, to), sorted stably.
   *
   * `includeHolidays` merges in the read-only overlay: public holidays (see
   * holidays.js) and the days the clocks change (see dst.js). It is opt-in
   * per call rather than automatic because the consumers of this function do
   * not agree on what a holiday is: the visual surfaces want to show it, while
   * the booking engine, the reminder scheduler, search, the app-to-app API and
   * the exporter would each be wrong to treat a synthetic item as one of the
   * user's own events. Only the three views that draw a day's items pass it.
   */
  function getEventsInRange(from, to, { includeHidden = false, includeHolidays = false } = {}) {
    const hidden = new Set(settings.hiddenColors);
    const out = [];
    for (const ev of events.values()) {
      if (ev.recurrence) {
        for (const occ of expandOccurrences(ev, from, to)) out.push(occ);
      } else if (eventInRange(ev, from, to)) {
        out.push(ev);
      }
    }
    const visible = out.filter((ev) => includeHidden || !hidden.has(ev.color));
    // Holidays carry no palette color, so they are appended AFTER the category
    // filter rather than run through it — hiding "Blue" must not hide Christmas.
    if (includeHolidays) {
      visible.push(...getHolidaysInRange(resolveHolidayCountry(settings.holidayCountry), from, to));
      if (settings.clockChanges) visible.push(...getClockChangesInRange(browserZone(), from, to));
    }
    return visible.sort(
      (a, b) =>
        Number(b.allDay) - Number(a.allDay) ||
        a.start - b.start ||
        // Within one day, the overlay comes first — a holiday, then a clock
        // change: it is the context the rest of the day is read against, not
        // another thing on the list. Placed after the start comparison so
        // this only ever orders same-day items.
        Number(Boolean(b.readOnly)) - Number(Boolean(a.readOnly)) ||
        Number(Boolean(b.holiday)) - Number(Boolean(a.holiday)) ||
        b.end - b.start - (a.end - a.start),
    );
  }

  /* ---- Persistence helpers -------------------------------------------- */

  function cloneEvent(ev) {
    return ev ? JSON.parse(JSON.stringify(ev)) : null;
  }
  function cacheAndWrite(ev) {
    events.set(ev.id, ev);
    return kv.set(EVENT_PREFIX + ev.id, ev);
  }
  /** Restore a previously-captured master snapshot (used by undo). */
  function restoreSnapshot(snap) {
    const ev = normalizeEvent(snap);
    events.set(ev.id, ev);
    emit();
    return kv.set(EVENT_PREFIX + ev.id, ev);
  }

  /**
   * Undo a single-occurrence mutation by restoring only that occurrence's slice
   * — its override value and its exdate membership — onto the CURRENT master.
   * This is deliberately surgical: a whole-master snapshot restore would wipe a
   * *sibling* occurrence edited while this undo toast was still on screen. Falls
   * back to the snapshot if the series was deleted or de-recurred meanwhile.
   */
  function revertOccurrence(seriesId, rid, prevOverride, wasExdate, snap) {
    const cur = events.get(seriesId);
    if (!cur || !cur.recurrence) return restoreSnapshot(snap);
    const applySlice = (m) => {
      const overrides = { ...(m.overrides || {}) };
      if (prevOverride === undefined) delete overrides[rid];
      else overrides[rid] = prevOverride;
      const exdates = wasExdate
        ? [...new Set([...(m.exdates || []), rid])]
        : (m.exdates || []).filter((x) => x !== rid);
      return { ...m, overrides, exdates };
    };
    const reverted = normalizeEvent(applySlice(cur));
    events.set(reverted.id, reverted);
    emit();
    // Same merge-before-write as the mutation being undone (see writeSliced).
    return writeSliced(seriesId, reverted, (m) => Boolean(m.recurrence), applySlice, cur).then((written) => {
      if (!sameEventContent(written, reverted)) emit();
      return written;
    });
  }

  /* ---- Mutations ------------------------------------------------------- */

  async function saveEvent(input) {
    const existing = input.id ? events.get(input.id) : null;
    const ev = normalizeEvent({ ...existing, ...input });
    events.set(ev.id, ev);
    emit();
    await writeOrRevert(events, ev.id, ev, existing, () => kv.set(EVENT_PREFIX + ev.id, ev));
    return ev;
  }

  async function deleteEvent(id) {
    const existing = events.get(id);
    if (!existing) return null;
    events.delete(id);
    emit();
    await writeOrRevert(events, id, undefined, existing, () => kv.del(EVENT_PREFIX + id));
    return existing;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * One batched `kv.set([{ key, value }, …])` write of events, retried with
   * exponential backoff on a rate limit (see the IMPORT_* constants above —
   * puter.kv 429s bursts of one-request-per-event writes). All-or-nothing per
   * chunk; resolves false when the write never landed. Shared by importEvents
   * and applyOutOfOffice, the two bulk writers.
   */
  async function persistChunk(chunk) {
    let backoff = IMPORT_BACKOFF_MS;
    for (let attempt = 1; ; attempt++) {
      try {
        await kv.set(chunk.map((ev) => ({ key: EVENT_PREFIX + ev.id, value: ev })));
        return true;
      } catch (err) {
        // Rate limits get the full retry budget; anything else (network blip,
        // server hiccup) gets one quick retry before counting as failed.
        if (attempt >= (isRateLimitError(err) ? IMPORT_MAX_ATTEMPTS : 2)) return false;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, IMPORT_BACKOFF_CAP_MS);
      }
    }
  }

  /**
   * Bulk-add imported events. Each is given a fresh id, so importing is purely
   * additive and never overwrites existing events. Emits once up front (the
   * events appear immediately), then persists in sequential batched writes —
   * puter.kv rate-limits a large import fired as one request per event (429
   * `too_many_requests`), but its `set` accepts an array of entries, so a few
   * chunked requests replace hundreds. Rate-limited chunks retry with
   * exponential backoff; a chunk whose write never lands is removed again so
   * the calendar only shows what actually persisted. Reports progress via
   * `onProgress(done, total)` and resolves to `{ imported, failed,
   * failedEvents }`, where `failedEvents` can be passed straight back in to
   * retry only what's missing (import is additive, so re-importing the whole
   * source file would duplicate the successes).
   */
  async function importEvents(list, { onProgress } = {}) {
    if (!Array.isArray(list)) return { imported: 0, failed: 0, failedEvents: [] };
    const added = [];
    for (const input of list) {
      if (!input || typeof input !== 'object') continue;
      // Skip undated / malformed entries instead of importing them stamped at
      // "now": an .ics VEVENT with a missing or unparseable DTSTART parses to a
      // non-finite start, which normalizeEvent would otherwise coerce to the
      // current time (silently manufacturing a junk event and inflating the
      // "Imported N events" count). The JSON path already guards this in
      // data-io; enforcing it here covers every import source.
      if (!Number.isFinite(input.start)) continue;
      const ev = normalizeEvent({ ...input, id: undefined });
      events.set(ev.id, ev);
      added.push(ev);
    }
    if (!added.length) return { imported: 0, failed: 0, failedEvents: [] };
    emit();

    let done = 0;
    const failedEvents = [];
    let reinstated = false;
    for (let i = 0; i < added.length; i += IMPORT_CHUNK) {
      const chunk = added.slice(i, i + IMPORT_CHUNK);
      if (await persistChunk(chunk)) {
        // A load() that ran between chunks — the booking sync and the API's
        // freshness re-read both reload on the emit above — listed a cloud
        // that held only the chunks landed by then, and its clear-and-
        // repopulate dropped the rest from memory. Now that this chunk is in
        // the cloud, make sure it is in memory too, or the import would end
        // reporting "Imported N" over a calendar missing most of them until
        // the next load.
        for (const ev of chunk) {
          if (!events.has(ev.id)) {
            events.set(ev.id, ev);
            reinstated = true;
          }
        }
      } else {
        failedEvents.push(...chunk);
      }
      done += chunk.length;
      if (onProgress) {
        try {
          onProgress(done, added.length);
        } catch {
          /* a progress-display bug must not abort the import */
        }
      }
    }

    if (failedEvents.length) {
      // Drop what never reached the cloud, or it would silently vanish on the
      // next load and the "Imported N" count would overpromise.
      for (const ev of failedEvents) events.delete(ev.id);
      emit();
    } else if (reinstated) {
      emit();
    }
    return { imported: added.length - failedEvents.length, failed: failedEvents.length, failedEvents };
  }

  /** JSON identity minus the write stamp — "would this write change anything". */
  function sameEventContent(a, b) {
    return JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 });
  }

  /**
   * Persist a slice-scoped event mutation with merge-before-write: re-read the
   * cloud copy and apply the slice to THAT, not to this device's master. All
   * per-occurrence state (exdates + overrides) and every guest's answer travel
   * inside one KV value, and this device's copy can be a whole session stale —
   * rewriting it from memory resurrects occurrences cancelled on another
   * device, and drops answers and edits recorded there, since our last load.
   * `applySlice` must be pure and idempotent (safe to apply to a newer master);
   * `accepts` guards shapes the slice no longer fits (e.g. de-recurred), where
   * the optimistic in-memory result — yesterday's exact behavior — stands.
   * Memory is updated to what was actually written, so a rebase also pulls the
   * other device's changes forward; the caller emits when that changed content.
   * `prev` is the master as it stood before the mutation — what memory goes
   * back to if the write is refused (see writeOrRevert).
   */
  async function writeSliced(id, optimistic, accepts, applySlice, prev) {
    let toWrite = optimistic;
    try {
      const cloud = coerceValue(await kv.get(EVENT_PREFIX + id));
      if (cloud && typeof cloud === 'object') {
        const base = normalizeEvent(cloud, stampOf(cloud));
        if (base.id === optimistic.id && accepts(base)) toWrite = normalizeEvent(applySlice(base));
      }
    } catch {
      /* cloud unreadable — the optimistic write is what always happened before */
    }
    events.set(toWrite.id, toWrite);
    await writeOrRevert(events, toWrite.id, toWrite, prev, () =>
      kv.set(EVENT_PREFIX + toWrite.id, toWrite),
    );
    return toWrite;
  }

  /** Edit a single occurrence (this-occurrence scope) by writing an override. */
  async function updateOccurrence(seriesId, recurrenceId, patch) {
    const master = events.get(seriesId);
    if (!master || !master.recurrence) return null;
    const rid = Number(recurrenceId);
    // Refuse a rid the schedule never produces: the override would be junk the
    // views filter out, silently accumulating on the master forever.
    if (!isScheduledOccurrence(master, rid)) return null;
    // Capture only this occurrence's prior slice so undo can't clobber a sibling.
    const prevOverride = master.overrides ? master.overrides[rid] : undefined;
    const wasExdate = (master.exdates || []).includes(rid);
    const snap = cloneEvent(master);

    const applySlice = (m) => {
      const overrides = { ...(m.overrides || {}) };
      overrides[rid] = { ...(overrides[rid] || {}), ...patch };
      return { ...m, overrides, exdates: (m.exdates || []).filter((x) => x !== rid) };
    };
    const updated = normalizeEvent(applySlice(master));
    events.set(updated.id, updated);
    emit();
    const written = await writeSliced(seriesId, updated, (m) => Boolean(m.recurrence), applySlice, master);
    if (!sameEventContent(written, updated)) emit();
    return { event: written, undo: () => revertOccurrence(seriesId, rid, prevOverride, wasExdate, snap) };
  }

  /** Cancel a single occurrence (this-occurrence scope). */
  async function deleteOccurrence(seriesId, recurrenceId) {
    const master = events.get(seriesId);
    if (!master || !master.recurrence) return null;
    const rid = Number(recurrenceId);
    // Same guard as updateOccurrence: an off-pattern rid would write an inert
    // exdate onto the master and report a deletion that never happened.
    if (!isScheduledOccurrence(master, rid)) return null;
    const prevOverride = master.overrides ? master.overrides[rid] : undefined;
    const wasExdate = (master.exdates || []).includes(rid);
    const snap = cloneEvent(master);

    const applySlice = (m) => {
      const overrides = { ...(m.overrides || {}) };
      delete overrides[rid];
      return { ...m, exdates: [...new Set([...(m.exdates || []), rid])], overrides };
    };
    const updated = normalizeEvent(applySlice(master));
    events.set(updated.id, updated);
    emit();
    const written = await writeSliced(seriesId, updated, (m) => Boolean(m.recurrence), applySlice, master);
    if (!sameEventContent(written, updated)) emit();
    return { event: written, undo: () => revertOccurrence(seriesId, rid, prevOverride, wasExdate, snap) };
  }

  /**
   * Edit the whole series (entire-series scope). Content-only edits keep
   * exceptions; changing the time, duration, all-day flag or rule clears them.
   * The occurrence's DATE is not moved — the pattern owns the dates — only its
   * time-of-day and duration carry across.
   */
  async function updateSeries(seriesId, patch) {
    const master = events.get(seriesId);
    if (!master || !master.recurrence) return null;
    const snap = cloneEvent(master);

    const allDay = patch.allDay != null ? Boolean(patch.allDay) : master.allDay;
    const hasTime = Number.isFinite(patch.start) && Number.isFinite(patch.end);
    const { start, end } = hasTime
      ? reproject(master.start, patch.start, patch.end, allDay)
      : { start: master.start, end: master.end };
    const recurrence = patch.recurrence !== undefined ? patch.recurrence : master.recurrence;

    const timeChanged =
      start !== master.start || end - start !== master.end - master.start || allDay !== master.allDay;
    const ruleChanged = !rulesEqual(recurrence, master.recurrence, start);
    const keepExceptions = !timeChanged && !ruleChanged;

    const updated = normalizeEvent({
      ...master,
      title: patch.title != null ? patch.title : master.title,
      description: patch.description != null ? patch.description : master.description,
      location: patch.location != null ? patch.location : master.location,
      color: patch.color != null ? patch.color : master.color,
      reminders: patch.reminders != null ? patch.reminders : master.reminders,
      guests: patch.guests != null ? patch.guests : master.guests,
      organizer: patch.organizer !== undefined ? patch.organizer : master.organizer,
      // `undefined` leaves the master's link alone; an explicit null removes it
      // (normalizeEvent simply doesn't attach one). Same convention as organizer.
      meeting: patch.meeting !== undefined ? patch.meeting : master.meeting,
      allDay,
      start,
      end,
      recurrence,
      exdates: keepExceptions ? master.exdates : [],
      overrides: keepExceptions ? master.overrides : {},
    });

    events.set(updated.id, updated);
    emit();
    await writeOrRevert(events, updated.id, updated, master, () => kv.set(EVENT_PREFIX + updated.id, updated));
    return { event: updated, undo: () => restoreSnapshot(snap) };
  }

  /**
   * Edit this occurrence and all that follow (this-and-future scope): truncate
   * the original series just before the split and start a NEW series from the
   * split occurrence carrying the edited fields. Editing from the first
   * occurrence is equivalent to editing the whole series.
   */
  async function updateFuture(seriesId, recurrenceId, patch) {
    const master = events.get(seriesId);
    if (!master || !master.recurrence) return null;
    const rid = Number(recurrenceId);
    const rule = normalizeRecurrence(master.recurrence, master.start);
    const before = countScheduledBefore(rule, master.start, rid);
    if (before <= 0) return updateSeries(seriesId, patch);

    const snap = cloneEvent(master);

    // 1) Truncate the original series before the split.
    const truncRule = { ...master.recurrence };
    if (rule.count != null) {
      truncRule.count = before;
      truncRule.until = null;
    } else {
      // `until` is a date-semantic, end-of-day bound (see recurrence.js). A raw
      // `rid - 1` lands mid-day ON the split date for a timed series, so the
      // Repeat label and the custom dialog showed the split date as still
      // included — and a no-op round-trip through the dialog rebuilt
      // endOfDay(split date), resurrecting the split occurrence. End of the
      // previous day is engine-equivalent (max one scheduled start per day).
      truncRule.until = startOfDay(new Date(rid)).getTime() - 1;
    }
    const truncated = normalizeEvent({
      ...master,
      recurrence: truncRule,
      exdates: (master.exdates || []).filter((x) => x < rid),
      overrides: Object.fromEntries(
        Object.entries(master.overrides || {}).filter(([k]) => Number(k) < rid),
      ),
    });

    // 2) New series from the split occurrence.
    const allDay = patch.allDay != null ? Boolean(patch.allDay) : master.allDay;
    const hasTime = Number.isFinite(patch.start) && Number.isFinite(patch.end);
    const { start, end } = hasTime
      ? reproject(rid, patch.start, patch.end, allDay)
      : { start: rid, end: rid + (master.end - master.start) };

    const providedRule = patch.recurrence !== undefined ? patch.recurrence : master.recurrence;
    const patternSame = patternEqual(providedRule, master.recurrence, master.start);
    const endUnchanged =
      (providedRule?.count ?? null) === (rule.count ?? null) &&
      (providedRule?.until ?? null) === (rule.until ?? null);
    const newRule = { ...providedRule };
    // An unchanged, count-limited pattern carries its REMAINING count forward,
    // so splitting never changes the total number of occurrences. Any `until`
    // is left intact (carried in via ...providedRule): if the series was bounded
    // by BOTH count and until, the tail must still honor until, or nulling it
    // would let the remaining count overshoot the original end date and
    // resurrect occurrences that never existed.
    if (patternSame && endUnchanged && rule.count != null) {
      newRule.count = Math.max(1, rule.count - before);
    }

    // Carry future exceptions only when the schedule (times + pattern) is
    // unchanged, so their absolute recurrenceIds still line up. All-day spans
    // must be compared in calendar DAYS, not raw ms: the tail is re-anchored on
    // `rid`'s own day, so when either side covers a DST transition the same
    // day count differs by an hour of real time — a raw-ms comparison would
    // read that as a duration change and silently wipe future exceptions.
    const sameSpan =
      allDay && master.allDay
        ? Math.max(1, Math.round((end - start) / MS_PER_DAY)) ===
          Math.max(1, Math.round((master.end - master.start) / MS_PER_DAY))
        : end - start === master.end - master.start;
    const shifted = start !== rid || !sameSpan || allDay !== master.allDay || !patternSame;
    const futureExdates = shifted ? [] : (master.exdates || []).filter((x) => x > rid);
    const futureOverrides = shifted
      ? {}
      : Object.fromEntries(
          Object.entries(master.overrides || {}).filter(([k]) => Number(k) > rid),
        );

    const newMaster = normalizeEvent({
      id: undefined,
      title: patch.title != null ? patch.title : master.title,
      description: patch.description != null ? patch.description : master.description,
      location: patch.location != null ? patch.location : master.location,
      color: patch.color != null ? patch.color : master.color,
      reminders: patch.reminders != null ? patch.reminders : master.reminders,
      // Carry the master's out-of-office / declined state onto the tail series,
      // like updateSeries (which keeps them via ...master) and the truncated
      // original — this explicit field list would otherwise reset them to false.
      ooo: master.ooo,
      declined: master.declined,
      guests: patch.guests != null ? patch.guests : master.guests,
      organizer: patch.organizer !== undefined ? patch.organizer : master.organizer,
      // Both halves of the split keep the meeting link (same room) unless the
      // patch says otherwise — the truncated original keeps it via ...master.
      meeting: patch.meeting !== undefined ? patch.meeting : master.meeting,
      allDay,
      start,
      end,
      recurrence: newRule,
      exdates: futureExdates,
      overrides: futureOverrides,
      createdAt: master.createdAt,
    });

    events.set(truncated.id, truncated);
    events.set(newMaster.id, newMaster);
    emit();
    // Two KV writes can't be atomic, so ORDER decides what a failure between
    // them costs. Tail first: if the truncation write then fails, the cloud
    // holds the full original PLUS the tail — the split's occurrences show
    // twice, which is visible and fixable. The other order (truncation landing
    // without the tail) silently and permanently deletes every occurrence from
    // the split onward on the next load.
    try {
      await cacheAndWrite(newMaster);
    } catch (err) {
      // Nothing landed — put both halves of memory back (see writeOrRevert).
      if (events.get(newMaster.id) === newMaster) events.delete(newMaster.id);
      if (events.get(truncated.id) === truncated) events.set(truncated.id, master);
      emit();
      throw err;
    }
    // The tail is in the cloud; a refused truncation leaves the cloud holding
    // the full original PLUS the tail. Mirror exactly that in memory rather
    // than show a split that never happened.
    await writeOrRevert(events, truncated.id, truncated, master, () => cacheAndWrite(truncated));

    const undo = async () => {
      events.delete(newMaster.id);
      const restored = normalizeEvent(snap);
      events.set(restored.id, restored);
      emit();
      // Same reasoning in reverse: restore the full original before deleting
      // the tail, so a failure between the writes duplicates occurrences
      // rather than losing them.
      await kv.set(EVENT_PREFIX + restored.id, restored);
      await kv.del(EVENT_PREFIX + newMaster.id);
    };
    return { event: newMaster, truncated, undo };
  }

  /**
   * Cancel this occurrence and all that follow (this-and-future scope). From
   * the first occurrence this removes the whole series.
   */
  async function deleteFuture(seriesId, recurrenceId) {
    const master = events.get(seriesId);
    if (!master || !master.recurrence) return null;
    const rid = Number(recurrenceId);
    const rule = normalizeRecurrence(master.recurrence, master.start);
    const before = countScheduledBefore(rule, master.start, rid);
    const snap = cloneEvent(master);

    if (before <= 0) {
      events.delete(seriesId);
      emit();
      await writeOrRevert(events, seriesId, undefined, master, () => kv.del(EVENT_PREFIX + seriesId));
      return { undo: () => restoreSnapshot(snap) };
    }

    const truncRule = { ...master.recurrence };
    if (rule.count != null) {
      truncRule.count = before;
      truncRule.until = null;
    } else {
      // End-of-previous-day, not `rid - 1` — same date-semantic reasoning as
      // the updateFuture split above.
      truncRule.until = startOfDay(new Date(rid)).getTime() - 1;
    }
    const updated = normalizeEvent({
      ...master,
      recurrence: truncRule,
      exdates: (master.exdates || []).filter((x) => x < rid),
      overrides: Object.fromEntries(
        Object.entries(master.overrides || {}).filter(([k]) => Number(k) < rid),
      ),
    });

    events.set(updated.id, updated);
    emit();
    await writeOrRevert(events, updated.id, updated, master, () => kv.set(EVENT_PREFIX + updated.id, updated));
    return { event: updated, undo: () => restoreSnapshot(snap) };
  }

  /* ---- Out of office -------------------------------------------------- */

  /**
   * The spans an out-of-office record marks you away for: a one-off block's
   * own start..end, or — for a series master — every occurrence from the
   * series' start through OOO_SWEEP_HORIZON_MS past `now` (cancelled
   * occurrences skipped, moved ones honored, like the views). A materialized
   * occurrence carries no rule and so is a single span, its own.
   */
  function outOfOfficeWindows(ooo, now) {
    if (!ooo.recurrence) return [[ooo.start, ooo.end]];
    const to = Math.max(ooo.start, now) + OOO_SWEEP_HORIZON_MS;
    return expandOccurrences(ooo, ooo.start, to).map((occ) => [occ.start, occ.end]);
  }

  /**
   * Mark the plain, timed events an out-of-office block overlaps as `declined`
   * (Google keeps such events but greys them out). A repeating block declines
   * under each of its occurrences, out to a year past today (see
   * outOfOfficeWindows). Non-destructive and reversible: recurring series and
   * all-day events are left alone, and the returned `undo` restores every
   * affected event's prior state.
   */
  async function applyOutOfOffice(ooo, { now = Date.now() } = {}) {
    if (!ooo || !ooo.ooo || !Number.isFinite(ooo.start) || !Number.isFinite(ooo.end)) {
      return { declined: [], undo: () => {} };
    }
    const windows = outOfOfficeWindows(ooo, now);
    const affected = [];
    for (const ev of events.values()) {
      if (ev.id === ooo.id || ev.ooo || ev.allDay || ev.recurrence || ev.declined) continue;
      if (windows.some(([from, to]) => ev.start < to && ev.end > from)) affected.push(ev);
    }
    if (!affected.length) return { declined: [], undo: () => {} };

    const affectedIds = affected.map((e) => e.id);
    for (const ev of affected) {
      const updated = normalizeEvent({ ...ev, declined: true });
      events.set(updated.id, updated);
    }
    emit();
    // Batched + sequential + rate-limit-retried, like importEvents: a wide OOO
    // over a busy calendar can overlap dozens of events, and a Promise.all of
    // one kv.set per event is exactly the burst puter.kv 429s — rejecting
    // AFTER a random subset persisted, with the undo lost to the throw. If a
    // chunk still fails, put everything back (memory always; cloud for the
    // chunks that landed, best-effort) so memory and cloud never diverge.
    const updatedList = affectedIds.map((id) => events.get(id));
    const written = [];
    let reinstated = false;
    for (let i = 0; i < updatedList.length; i += IMPORT_CHUNK) {
      const chunk = updatedList.slice(i, i + IMPORT_CHUNK);
      if (await persistChunk(chunk)) {
        written.push(...chunk);
        // A load() between chunks repopulated memory from a cloud that held
        // this chunk's events still un-declined (see importEvents); now that
        // the cloud has them declined, memory must too.
        for (const ev of chunk) {
          const cur = events.get(ev.id);
          if (cur && !cur.declined && cur.updatedAt <= ev.updatedAt) {
            events.set(ev.id, ev);
            reinstated = true;
          }
        }
        continue;
      }
      for (const ev of affected) events.set(ev.id, ev);
      emit();
      if (written.length) await persistChunk(affected.filter((ev) => written.some((w) => w.id === ev.id)));
      throw new Error('out of office: could not update the overlapping events');
    }
    if (reinstated) emit();

    // Surgical undo: revert ONLY the flag we set, and only on events that still
    // exist and are still declined. Like the per-occurrence undos, this avoids
    // clobbering an edit made to (or resurrecting a deletion of) one of these
    // events while the Undo toast is still on screen. Every affected event had
    // declined === false before (the filter above skips already-declined ones),
    // so flipping it back fully restores the prior state.
    const undo = async () => {
      const reverted = [];
      for (const id of affectedIds) {
        const cur = events.get(id);
        if (!cur || !cur.declined) continue;
        const ev = normalizeEvent({ ...cur, declined: false });
        events.set(ev.id, ev);
        reverted.push(ev);
      }
      if (!reverted.length) return;
      emit();
      for (let i = 0; i < reverted.length; i += IMPORT_CHUNK) {
        if (!(await persistChunk(reverted.slice(i, i + IMPORT_CHUNK)))) {
          throw new Error('out of office: could not undo every event');
        }
      }
    };
    return { declined: affectedIds, undo };
  }

  /** Toggle a single event's declined flag (manual accept/decline). */
  async function setDeclined(id, declined) {
    const existing = events.get(id);
    if (!existing) return null;
    return saveEvent({ ...existing, declined: Boolean(declined) });
  }

  /**
   * Record the signed-in user's RSVP on an event (pass the series master's id
   * for a recurring invite — v1 responds series-wide, like replying to the
   * whole invitation). Updates their guest entry and mirrors a "No" onto the
   * `declined` flag so the event dims the same way an OOO-declined one does.
   */
  async function rsvpEvent(id, status, selfEmail) {
    const existing = events.get(id);
    const email = typeof selfEmail === 'string' ? selfEmail.trim().toLowerCase() : '';
    if (!existing || !email || !GUEST_STATUS_SET.has(status)) return null;
    if (!(existing.guests || []).some((g) => g.email === email)) return null;
    // One guest's slice of the shared guests array — merged onto the cloud
    // copy (writeSliced) so answering here can't wipe answers other guests
    // gave (pulled on another device) since this one last loaded.
    const applySlice = (m) => ({
      ...m,
      guests: (m.guests || []).map((g) => (g.email === email ? { ...g, status } : g)),
      declined: status === 'declined',
    });
    const updated = normalizeEvent(applySlice(existing));
    events.set(updated.id, updated);
    emit();
    const written = await writeSliced(id, updated, () => true, applySlice, existing);
    if (!sameEventContent(written, updated)) emit();
    return written;
  }

  /**
   * Merge guests' answers pulled from the user's RSVP worker (see
   * rsvp-links.js) into an event. Per guest, a remote answer wins only when
   * its `respondedAt` is newer than the guest's stored `rsvpAt` — replays and
   * re-pulls are no-ops, so this can run on every boot/card-open safely.
   * Returns the saved event, or null when nothing changed.
   */
  async function applyRsvpResponses(id, responses) {
    const existing = events.get(id);
    if (!existing || !Array.isArray(responses)) return null;
    const byEmail = new Map();
    for (const r of responses) {
      if (r && typeof r.email === 'string') byEmail.set(r.email.trim().toLowerCase(), r);
    }
    const mergeGuests = (list) => {
      let changed = false;
      const guests = (list || []).map((g) => {
        const r = byEmail.get(g.email);
        if (!r || !GUEST_STATUS_SET.has(r.status)) return g;
        const at = Number.isFinite(r.respondedAt) ? Math.round(r.respondedAt) : 0;
        if (at <= (g.rsvpAt || 0)) return g;
        changed = true;
        const next = { ...g, status: r.status, rsvpAt: at };
        const comment = typeof r.comment === 'string' ? r.comment.trim().slice(0, 500) : '';
        if (comment) next.comment = comment;
        else delete next.comment;
        return next;
      });
      return { changed, guests };
    };
    const local = mergeGuests(existing.guests);
    if (!local.changed) return null;
    // Newer-respondedAt-wins per guest is idempotent, so re-applying it to the
    // cloud copy (writeSliced) is safe — and keeps this pull from wiping other
    // fields, or other guests' answers, recorded by another device.
    const applySlice = (m) => ({ ...m, guests: mergeGuests(m.guests).guests });
    const updated = normalizeEvent(applySlice(existing));
    events.set(updated.id, updated);
    emit();
    const written = await writeSliced(id, updated, () => true, applySlice, existing);
    if (!sameEventContent(written, updated)) emit();
    return written;
  }

  /* ---- Tasks (independent of events) ---------------------------------- */

  function getAllTasks() {
    return [...tasks.values()];
  }

  function getTask(id) {
    return tasks.get(id) || null;
  }

  /**
   * Tasks whose due instant falls in the half-open range [from, to), sorted so
   * open tasks come before done ones, then by due time.
   *
   * Runs through the same category filter as getEventsInRange: a task carries
   * a palette color too, so unchecking "Indigo" has to take the Indigo tasks
   * off the calendar along with the Indigo events, or the filter reads as
   * half-applied. `includeHidden` is for consumers that are not drawing the
   * calendar — the agenda's empty state counts what the filter hid so it can
   * say so instead of claiming the list is empty.
   */
  function getTasksInRange(from, to, { includeHidden = false } = {}) {
    const hidden = new Set(settings.hiddenColors);
    const out = [];
    for (const t of tasks.values()) {
      if (t.due < from || t.due >= to) continue;
      if (!includeHidden && hidden.has(t.color)) continue;
      out.push(t);
    }
    return out.sort(
      (a, b) => Number(a.done) - Number(b.done) || a.due - b.due || Number(a.allDay) - Number(b.allDay),
    );
  }

  async function saveTask(input) {
    const existing = input.id ? tasks.get(input.id) : null;
    const t = normalizeTask({ ...existing, ...input });
    tasks.set(t.id, t);
    emit();
    await writeOrRevert(tasks, t.id, t, existing, () => kv.set(TASK_PREFIX + t.id, t));
    return t;
  }

  /** Flip a task's done flag; returns the updated task (or null if unknown). */
  async function toggleTask(id) {
    const existing = tasks.get(id);
    if (!existing) return null;
    return saveTask({ ...existing, done: !existing.done });
  }

  async function deleteTask(id) {
    const existing = tasks.get(id);
    if (!existing) return null;
    tasks.delete(id);
    emit();
    await writeOrRevert(tasks, id, undefined, existing, () => kv.del(TASK_PREFIX + id));
    return existing;
  }

  function getSettings() {
    return { ...settings };
  }

  // Saves are chained (one read-merge-write at a time) and the patches not yet
  // known to be in the cloud ride along, so a quick second toggle can neither
  // race the first one's write nor be transiently reverted by its merge.
  let settingsWrite = Promise.resolve();
  const settingsPending = [];

  async function saveSettings(patch) {
    // `categoryNames` is a map, and a patch for it carries only the categories
    // it means to change (see the key-by-key merge below). Apply it the same
    // way here, or this optimistic update would drop every name the patch is
    // silent about until the merge below hands them back — the sidebar losing
    // its other renamed rows for a frame, and the caller being pushed towards
    // sending the whole map instead, which is what the merge exists to avoid.
    const local = { ...settings, ...patch };
    if (patch.categoryNames) {
      local.categoryNames = { ...(settings.categoryNames || {}), ...patch.categoryNames };
    }
    settings = local;
    emit();
    settingsPending.push(patch);
    const write = settingsWrite.then(async () => {
      // Merge-before-write: the settings map is one KV value shared by every
      // device, and this device's copy is as old as its load(). Writing the
      // whole map from memory reverts fields another device changed since —
      // a phone's theme pick undoing a laptop's hidden-colors toggle. Every
      // still-pending local patch is the slice this device owns; lay them
      // over the freshest copy the cloud will give us, falling back to the
      // local merge (the previous behavior in full) when it won't give one.
      const included = settingsPending.slice();
      try {
        const cloud = coerceValue(await kv.get(SETTINGS_KEY));
        if (cloud && typeof cloud === 'object') {
          // Lay EVERY patch still pending over the cloud copy — including the
          // ones pushed while the get above was in flight, not only the
          // `included` ones this write will retire. A second quick toggle
          // otherwise flipped back for one round trip: the merge, computed
          // without it, replaced the local settings, and it only returned
          // when its own write's merge ran. It stays pending and rides in
          // that later write, so the cloud gets it either way.
          const merged = settingsPending.reduce(
            (acc, p) => {
              const next = { ...acc, ...p };
              // `categoryNames` is a map, not a scalar: two devices renaming
              // two different categories must both survive, so patch it
              // key-by-key instead of letting a whole map replace a whole map.
              // Which is only worth anything if the patch names just the
              // categories it changed — a whole-map patch would still carry
              // this device's stale names over the cloud's newer ones.
              // A name cleared back to the palette default travels as '' for
              // exactly this reason — dropping the key would leave the cloud's
              // older name in place and undo the clear.
              if (p.categoryNames) {
                next.categoryNames = { ...(acc.categoryNames || {}), ...p.categoryNames };
              }
              return next;
            },
            { ...DEFAULT_SETTINGS, ...cloud },
          );
          if (!Array.isArray(merged.hiddenColors)) merged.hiddenColors = [];
          merged.bookingName = sanitizeBookingName(merged.bookingName);
          merged.mailInvites = sanitizeMailInvites(merged.mailInvites);
          merged.mailInvitesShowUnknown = sanitizeShowUnknown(merged.mailInvitesShowUnknown);
          merged.showWeekNumbers = sanitizeShowWeekNumbers(merged.showWeekNumbers);
          // Last, so the '' tombstones above have already won their merge.
          merged.categoryNames = sanitizeCategoryNames(merged.categoryNames);
          if (JSON.stringify(merged) !== JSON.stringify(settings)) {
            settings = merged;
            emit();
          }
        }
      } catch {
        /* unreadable cloud copy */
      }
      await kv.set(SETTINGS_KEY, settings);
      // Only now are these patches known to be in the cloud; a rejected write
      // keeps them pending so the next successful save carries them.
      for (const p of included) {
        const i = settingsPending.indexOf(p);
        if (i !== -1) settingsPending.splice(i, 1);
      }
    });
    // Keep the chain alive past a rejected write (offline) — the next save
    // must still run; this caller still sees its own rejection.
    settingsWrite = write.catch(() => {});
    await write;
    return getSettings();
  }

  return {
    load,
    subscribe,
    revision,
    getAllEvents,
    getEvent,
    getEventsInRange,
    saveEvent,
    deleteEvent,
    importEvents,
    updateOccurrence,
    deleteOccurrence,
    updateSeries,
    updateFuture,
    deleteFuture,
    applyOutOfOffice,
    setDeclined,
    rsvpEvent,
    applyRsvpResponses,
    getAllTasks,
    getTask,
    getTasksInRange,
    saveTask,
    toggleTask,
    deleteTask,
    getSettings,
    saveSettings,
  };
}
