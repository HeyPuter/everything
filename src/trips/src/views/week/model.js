// The week overview across trips: which trips run on each day of a week and their timed plans, bookings and the
// member's to-dos due. Pure; inputs are `{entry, data}` from src/lib/notify/replica.js.
import { addDays, daysBetween, isDate, isTime } from '../../shared/dates.js';
import { resEntries } from '../../lib/res/days.js';

const byTime = (a, b) => (a.time ?? '99:99').localeCompare(b.time ?? '99:99') || a.order - b.order;
const byOrder = (a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : (a.cr ?? 0) - (b.cr ?? 0));
const normName = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();

/** The seven ISO dates of the week holding `date`, starting on `firstDay` (0 = Sunday). */
export function weekDates(date, firstDay = 1) {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const start = addDays(date, -((weekday - firstDay + 7) % 7));
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

/** `{start, end, title}` for a trip, from its replica when present, else the `me:spaces` entry. */
export function tripSpan({ entry, data }) {
  const meta = data?.meta ?? {};
  const pick = (field) => (isDate(meta[field]) ? meta[field] : isDate(entry[field]) ? entry[field] : null);
  const start = pick('start');
  const end = pick('end') ?? start;
  return { start, end: end && start && end < start ? start : end, title: String(meta.title ?? entry.title ?? '').trim(), archived: Boolean(meta.archived) };
}

function mineOrOpen(todo, uid, assignees) {
  if (todo.who) return todo.who === uid;
  const listed = assignees.get(normName(todo.list)) ?? [];
  return listed.length === 0 || listed.includes(uid);
}

/** Items one trip has on `date`: timed stops, bookings (not mid-stay or mid-transit) and the member's due to-dos. */
function itemsOn(data, date, { uid, labels }) {
  const out = [];
  if (!data) return { items: out, untimed: 0 };
  const days = [...(data.day ?? [])].sort(byOrder);
  const dayIds = new Set(days.filter((day) => day.date === date).map((day) => day.id));
  const places = new Map((data.place ?? []).map((place) => [place.id, place]));
  let untimed = 0;
  let order = 0;
  for (const visit of [...(data.visit ?? [])].sort(byOrder)) {
    if (!dayIds.has(visit.dayId)) continue;
    const name = String(places.get(visit.placeId)?.name ?? visit.title ?? '').trim();
    if (!isTime(visit.start)) { if (name) untimed += 1; continue; }
    out.push({ kind: 'visit', tab: 'plan', time: visit.start, label: name || labels.visit(), order: order++ });
  }
  for (const res of data.res ?? []) {
    if (res.deleted || res.status === 'cancelled') continue;
    for (const item of resEntries(res, days)) {
      if (item.date !== date || item.phase === 'middle') continue;
      const leg = item.leg !== null ? res.legs?.[item.leg] : null;
      const route = leg ? [leg.from, leg.to].map((end) => end?.code || end?.name).filter(Boolean).join(' → ') : '';
      out.push({ kind: 'booking', tab: 'bookings', type: res.type, phase: item.name, time: isTime(item.time) ? item.time : null, tz: item.tz,
        label: String(res.title ?? '').trim() || route || labels.type(res.type), detail: res.title && route ? route : '', order: order++ });
    }
  }
  const assignees = new Map();
  for (const list of data.listMeta ?? []) if (list.kind === 'todo') assignees.set(normName(list.name), Array.isArray(list.assignees) ? list.assignees : []);
  for (const todo of data.todo ?? []) {
    if (todo.deleted || todo.done || todo.due !== date || !mineOrOpen(todo, uid, assignees)) continue;
    out.push({ kind: 'todo', tab: 'lists', time: null, label: String(todo.name ?? '').trim() || labels.todo(), order: order++ });
  }
  return { items: out.sort(byTime), untimed };
}

const DEFAULT_LABELS = { visit: () => 'Stop', type: (type) => type, todo: () => 'To-do' };

/**
 * One week: `{dates, days: [{date, today, trips: [{key, ref, title, color, dayNumber, dayCount, items, untimed, cached}]}],
 * trips: [...in the week], missing: [...in the week without a replica], next}` where `next` is the first trip starting
 * after the week. Archived trips and undated trips are left out.
 */
export function weekPlan(trips, dates, { uid, today, labels = DEFAULT_LABELS } = {}) {
  const first = dates[0];
  const last = dates.at(-1);
  const dated = trips.map((trip) => ({ trip, span: tripSpan(trip) })).filter(({ span }) => span.start && !span.archived)
    .sort((a, b) => (a.span.start < b.span.start ? -1 : a.span.start > b.span.start ? 1 : a.span.title.localeCompare(b.span.title)));
  const inWeek = dated.filter(({ span }) => span.start <= last && span.end >= first);
  const colors = new Map(inWeek.map(({ trip }, index) => [trip.entry.ref.s, (index % 8) + 1]));
  const days = dates.map((date) => ({
    date, today: date === today,
    trips: inWeek.filter(({ span }) => span.start <= date && span.end >= date).map(({ trip, span }) => {
      const { items, untimed } = itemsOn(trip.data, date, { uid, labels });
      return {
        key: `${trip.entry.ref.w}/${trip.entry.ref.s}`, ref: trip.entry.ref, title: span.title, color: colors.get(trip.entry.ref.s),
        dayNumber: daysBetween(span.start, date) + 1, dayCount: daysBetween(span.start, span.end) + 1, items, untimed, cached: Boolean(trip.data),
      };
    }),
  }));
  const next = dated.find(({ span }) => span.start > last);
  return {
    dates, days,
    trips: inWeek.map(({ trip, span }) => ({ ref: trip.entry.ref, title: span.title, start: span.start, end: span.end, color: colors.get(trip.entry.ref.s), cached: Boolean(trip.data) })),
    missing: inWeek.filter(({ trip }) => !trip.data).map(({ trip, span }) => ({ ref: trip.entry.ref, title: span.title })),
    next: next ? { ref: next.trip.entry.ref, title: next.span.title, start: next.span.start } : null,
  };
}
