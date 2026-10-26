// The reminder schedule the events handler reads (`me:notify:sched`): `{v: 1, items: {<id>: reminder}, test?, tick?}`.
// A reminder is `{at, kind: 'trip'|'todo', space, w, trip, date, days?, name?}`. All-day reminders fire at 09:00 in
// the device's zone, as in the calendar feed. In-app reminder producers can pass their own items to `writeSchedule`.
import { addDays, browserTimeZone, isDate } from '../../shared/dates.js';
import { zonedEpoch } from '../res/time.js';
import { KEYS } from './model.js';

const DAY = 86_400_000;
export const HORIZON = 60 * DAY;
export const MAX_ITEMS = 200;
const MORNING = '09:00';

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const at9 = (date, zone) => { try { return zonedEpoch(date, MORNING, zone); } catch { return null; } };
const inWindow = (at, now) => at != null && at > now - DAY && at <= now + HORIZON;

/** Trip-start reminders for `me:spaces` entries, `lead` days before each start. */
export function tripReminders(entries, { lead, now, zone = browserTimeZone() }) {
  const items = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.ref?.k !== 'trip' || !isDate(entry.start) || !/^[a-z0-9]{16}$/.test(entry.ref.s ?? '')) continue;
    for (const days of lead) {
      const date = addDays(entry.start, -days);
      const at = at9(date, zone);
      if (!inWindow(at, now)) continue;
      items[`trip-${entry.ref.s}-${entry.start}-${days}`] = { at, kind: 'trip', space: entry.ref.s, w: entry.ref.w, trip: String(entry.title ?? '').slice(0, 200), date: entry.start, days };
    }
  }
  return items;
}

/** Due reminders for one trip's open to-dos assigned to `uid` or to nobody. */
export function todoReminders({ ref, title, todos, uid, now, zone = browserTimeZone() }) {
  const items = {};
  for (const todo of Array.isArray(todos) ? todos : []) {
    if (!todo || todo.deleted || todo.done || !isDate(todo.due) || (todo.who && todo.who !== uid)) continue;
    const at = at9(todo.due, zone);
    if (!inWindow(at, now) || !/^[a-z0-9]{16}$/.test(todo.id ?? '')) continue;
    items[`todo-${ref.s}-${todo.id}-${todo.due}`] = { at, kind: 'todo', space: ref.s, w: ref.w, trip: String(title ?? '').slice(0, 200), date: todo.due, name: String(todo.name ?? '').slice(0, 80) };
  }
  return items;
}

// FNV-1a over UTF-16 units, two 32-bit lanes: a short path-safe id for a reminder key.
function keyHash(value) {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ value.length;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

const FORWARDED = new Set(['trip', 'todo', 'booking', 'overdue']);
/**
 * Schedule items for reminders computed in the app (the in-app reminder model:
 * `{key, kind, ref, trip, title, start, fireAt, until, count?}`), ids `q-<hash of key>`.
 */
export function forwardedReminders(reminders, { now }) {
  const items = {};
  for (const item of Array.isArray(reminders) ? reminders : []) {
    if (!item || typeof item.key !== 'string' || !FORWARDED.has(item.kind) || !Number.isFinite(item.fireAt) || !/^[a-z0-9]{16}$/.test(item.ref?.s ?? '')) continue;
    if (!inWindow(item.fireAt, now) || (Number.isFinite(item.until) && item.until <= now)) continue;
    items[`q-${keyHash(item.key)}`] = {
      at: item.fireAt, kind: item.kind, space: item.ref.s, w: item.ref.w, trip: String(item.trip ?? '').slice(0, 200),
      date: isDate(item.start?.date) ? item.start.date : '', ...(item.kind === 'overdue' ? { count: Number.isInteger(item.count) ? item.count : 0 } : { text: String(item.title ?? '').slice(0, 200) }),
    };
  }
  return items;
}

/** Own trip-start items minus those a forwarded reminder already covers (same trip, same time). */
export function withoutCovered(own, forwarded) {
  const covered = new Set(Object.values(forwarded).filter((item) => item.kind === 'trip').map((item) => `${item.space}@${item.at}`));
  return Object.fromEntries(Object.entries(own).filter(([, item]) => !covered.has(`${item.space}@${item.at}`)));
}

/**
 * Path writes that make the stored schedule hold `items` for the reminders `owns(id)` selects, leaving the rest.
 * Past reminders older than a day are dropped. Returns `{set, remove}` or null when nothing changes.
 */
export function scheduleChanges(stored, items, owns, now) {
  const current = plain(stored?.items) ? stored.items : {};
  const set = {};
  const remove = [];
  for (const [id, item] of Object.entries(current)) {
    const stale = !plain(item) || !Number.isFinite(item.at) || item.at < now - 2 * DAY;
    if ((owns(id) && !Object.hasOwn(items, id)) || stale) remove.push(`items.${id}`);
  }
  const kept = Object.keys(current).length - remove.length;
  let room = MAX_ITEMS - kept;
  for (const [id, item] of Object.entries(items).sort((a, b) => a[1].at - b[1].at)) {
    const same = plain(current[id]) && JSON.stringify(current[id]) === JSON.stringify(item);
    if (same) continue;
    if (!Object.hasOwn(current, id)) { if (room <= 0) continue; room -= 1; }
    set[`items.${id}`] = item;
  }
  if (!Object.keys(set).length && !remove.length) return null;
  return { set, remove };
}

/** Writes `items` (owned by `owns`) to the schedule. One read, then path writes only. */
export async function writeSchedule(puter, items, owns, now = Date.now()) {
  const stored = await puter.kv.get(KEYS.sched);
  const changes = scheduleChanges(stored, items, owns, now);
  if (!changes) return false;
  if (Object.keys(changes.set).length) await puter.kv.update(KEYS.sched, { v: 1, ...changes.set });
  if (changes.remove.length) await puter.kv.remove(KEYS.sched, ...changes.remove);
  return true;
}

/** Asks the handler to send a test now; resolves the test id. */
export async function requestTest(puter, id, now = Date.now()) {
  await puter.kv.update(KEYS.sched, { v: 1, test: { id, at: now } });
  return id;
}

/** The next reminder time after `now`, for the open app's wake-up poke. */
export function nextDue(stored, now) {
  const times = Object.values(plain(stored?.items) ? stored.items : {}).map((item) => item?.at).filter((at) => Number.isFinite(at) && at > now);
  return times.length ? Math.min(...times) : null;
}
