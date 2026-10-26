// When reminders fire. The rules are the trip feed's VALARMs (src/lib/ics): trips at 09:00 `reminderDays` days
// before the start, timed bookings 3 h (flights) or 1 h before, the member's open to-dos at 09:00 on the due date.
// All-day items use the device's time zone; timed bookings their own. Overdue to-dos add one summary per trip per day.
import { addDays, isDate, isTime, zonedParts } from '../../shared/dates.js';
import { tripEvents } from '../ics/trip.js';
import { zonedEpoch } from '../res/time.js';

const MINUTE = 60_000;
const MORNING = 9 * 60;
const normName = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
export const refKey = (ref) => `${ref.w}/${ref.s}`;

function epochOf(point, zone) {
  try { return zonedEpoch(point.date, isTime(point.time) ? point.time : '00:00', isTime(point.time) && point.tz ? point.tz : zone); } catch { return null; }
}
const endOfDay = (date, zone) => epochOf({ date: addDays(date, 1) }, zone);
const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
// An all-day alarm `before` minutes ahead of midnight, read as a wall-clock time so DST days still fire at 09:00.
function wallClockAlarm(date, before, zone) {
  const days = Math.ceil(before / 1440) || 0;
  return epochOf({ date: addDays(date, -days), time: hhmm(days * 1440 - before) }, zone);
}
export const todayIn = (now, zone) => zonedParts(now, zone).date;

const kindOf = (uid) => (uid.includes('-trip@') ? 'trip' : uid.includes('-todo-') ? 'todo' : uid.includes('-res-') ? 'booking' : null);
const TABS = Object.freeze({ trip: 'plan', booking: 'bookings', todo: 'lists', overdue: 'lists' });

/** The member's open to-dos due before `today`, by the same rules as the Lists tab reminder. */
export function overdueTodos(data, { uid, today }) {
  const assignees = new Map();
  for (const list of data?.listMeta ?? []) if (list.kind === 'todo') assignees.set(normName(list.name), Array.isArray(list.assignees) ? list.assignees : []);
  return (data?.todo ?? []).filter((todo) => {
    if (todo.deleted || todo.done || !isDate(todo.due) || todo.due >= today) return false;
    if (todo.who) return todo.who === uid;
    const listed = assignees.get(normName(todo.list)) ?? [];
    return listed.length === 0 || listed.includes(uid);
  });
}

/**
 * Reminders for one trip: `[{key, kind, ref, tab, trip, title, start, startAt, fireAt, until, before, count?}]`, where
 * `key` changes when the item is re-dated (so it fires again) and `until` is when it stops being worth showing.
 */
export function tripReminders({ entry, data }, { uid, now = Date.now(), zone, labels } = {}) {
  const ref = entry.ref;
  const meta = data?.meta ?? {};
  if (meta.archived) return [];
  const trip = String(meta.title ?? entry.title ?? '').trim();
  const out = [];
  const events = data ? tripEvents({ ...data, meta: data.meta ?? { title: entry.title } }, { space: ref.s, member: uid, days: false, alarms: true, labels }) : [];
  for (const event of events) {
    const kind = kindOf(event.uid);
    if (!kind || !event.alarms?.length) continue;
    const startAt = epochOf(event.start, zone);
    if (startAt === null) continue;
    const until = isTime(event.start.time) ? startAt : endOfDay(event.start.date, zone);
    const stamp = `${event.start.date}T${event.start.time ?? ''}${event.start.tz ?? ''}`;
    for (const { before } of event.alarms) {
      out.push({
        key: `${refKey(ref)}|${event.uid}|${stamp}|${before}`, kind, ref, tab: TABS[kind], trip, title: event.summary,
        start: event.start, startAt, fireAt: isTime(event.start.time) ? startAt - before * MINUTE : wallClockAlarm(event.start.date, before, zone), until, before,
      });
    }
  }
  const today = todayIn(now, zone);
  const overdue = overdueTodos(data, { uid, today });
  if (overdue.length) {
    const fireAt = epochOf({ date: today, time: hhmm(MORNING) }, zone);
    out.push({ key: `${refKey(ref)}|overdue|${today}`, kind: 'overdue', ref, tab: TABS.overdue, trip, title: trip, start: { date: today }, startAt: fireAt, fireAt, until: endOfDay(today, zone), before: 0, count: overdue.length });
  }
  return out;
}

/** Reminders across trips, soonest first. Trips that ended more than a day ago are skipped. */
export function allReminders(trips, { uid, now = Date.now(), zone, labels } = {}) {
  const yesterday = addDays(todayIn(now, zone), -1);
  const out = [];
  for (const trip of trips) {
    const end = trip.data?.meta?.end ?? trip.entry.end;
    if (isDate(end) && end < yesterday) continue;
    out.push(...tripReminders(trip, { uid, now, zone, labels }));
  }
  return out.sort((a, b) => a.fireAt - b.fireAt || (a.key < b.key ? -1 : 1));
}

/** Reminders whose time has come and that are still relevant, minus those already shown (`fired` has their keys). */
export const dueNow = (reminders, { now = Date.now(), fired = new Set() } = {}) => reminders.filter((item) => item.fireAt <= now && now < item.until && !fired.has(item.key));
/** Reminders still ahead, soonest first, for lists. */
export const upcoming = (reminders, { now = Date.now(), limit = 20 } = {}) => reminders.filter((item) => now < item.until).sort((a, b) => a.fireAt - b.fireAt).slice(0, limit);
/** The next moment a reminder fires after `now`, or null. */
export function nextFire(reminders, now = Date.now()) {
  let next = null;
  for (const item of reminders) if (item.fireAt > now && (next === null || item.fireAt < next)) next = item.fireAt;
  return next;
}
