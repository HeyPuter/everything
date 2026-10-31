import { addDays, isDate, isTime, isTimeZone, timeMinutes, zonedParts } from '../../shared/dates.js';
import { zonedEpoch } from '../res/time.js';
import { isLodging, isTransport } from '../res/types.js';
import { fromMinor, isCurrency } from '../../shared/money.js';

const DOMAIN = 'trips.puter.com';
const MINUTE = 60_000;
/** All-day reminders fire at 09:00 local time. */
const MORNING = 9 * 60;
/** Length of a timed event whose end is unknown. */
const DEFAULT_MINUTES = 60;
const LEAD = Object.freeze({ flight: 180 });
const BOOKING_LEAD = 60;
const MAX_TRIP_ALARMS = 10;

const TYPE_NAMES = Object.freeze({
  flight: 'Flight', train: 'Train', bus: 'Bus', car: 'Car rental', taxi: 'Taxi', bike: 'Bike', cruise: 'Cruise', ferry: 'Ferry',
  transit: 'Transit', transport: 'Transport', lodging: 'Stay', restaurant: 'Restaurant', event: 'Event', tour: 'Tour',
  parking: 'Parking', other: 'Booking',
});

/** English labels for the worker feed; the client passes translated ones. */
export const DEFAULT_LABELS = Object.freeze({
  trip: () => 'Trip',
  visit: () => 'Visit',
  day: (number, title) => (title ? `Day ${number}: ${title}` : `Day ${number}`),
  todo: (name) => `To-do: ${name}`,
  checkIn: (time) => `Check-in ${time}`,
  checkOut: (time) => `Check-out ${time}`,
  type: (type) => TYPE_NAMES[type] ?? TYPE_NAMES.other,
  time: (time) => time,
  payment: (name, amount) => `Payment due: ${name} (${amount})`,
  money: (amount, currency) => `${fromMinor(amount, currency)} ${currency}`,
});

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const normName = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const byOrder = (a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : (a.cr ?? 0) - (b.cr ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const live = (list) => (Array.isArray(list) ? list.filter((item) => item && typeof item === 'object' && !item.deleted) : []);
const allDay = (first, last) => ({ start: { date: first }, end: { date: addDays(isDate(last) && last > first ? last : first, 1) } });

function wallMs(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const result = new Date(0);
  result.setUTCFullYear(y, m - 1, d);
  return result.getTime() + timeMinutes(time) * MINUTE;
}
const moment = (point) => (point.tz ? zonedEpoch(point.date, point.time, point.tz) : wallMs(point.date, point.time));

function later(point, minutes) {
  const epoch = moment(point) + minutes * MINUTE;
  if (point.tz) return { ...zonedParts(epoch, point.tz), tz: point.tz };
  const iso = new Date(epoch).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), tz: null };
}

/**
 * Start and end of a timed event. A floating start keeps the end floating; a zoned start lends its zone to an end
 * without one. An end that is missing or not after the start becomes `minutes` after it, so short events keep their
 * real length and unknown ones last an hour.
 */
function span(start, end, minutes = DEFAULT_MINUTES) {
  let finish = null;
  if (end && isDate(end.date) && isTime(end.time)) {
    finish = { date: end.date, time: end.time, tz: start.tz ? (end.tz ?? start.tz) : null };
    if (moment(finish) <= moment(start)) finish = null;
  }
  const { date, time, tz } = finish ?? later(start, minutes > 0 ? minutes : DEFAULT_MINUTES);
  return { start, end: { date, time, tz } };
}

const tripAlarms = (days) => [...new Set((Array.isArray(days) ? days : []).filter((n) => Number.isInteger(n) && n >= 0 && n <= 365))]
  .sort((a, b) => a - b).slice(0, MAX_TRIP_ALARMS).map((n) => ({ before: n * 1440 - MORNING }));

/** Open to-dos that are the member's, or nobody's (no assignee and no list assignees). Without a member, all of them. */
function mineOrUnassigned(todo, member, assignees) {
  if (!member) return true;
  if (todo.who) return todo.who === member;
  const listed = assignees.get(normName(todo.list)) ?? [];
  return listed.length === 0 || listed.includes(member);
}

/**
 * Calendar events for a trip. `data` holds `meta` and arrays per type (`day`, `visit`, `place`, `res`, `todo`,
 * `listMeta`, `exp`). Options: `space` (id for stable UIDs), `member` (uuid whose to-dos to include), `days` (per-day
 * all-day events listing untimed items), `alarms`, `labels`.
 */
export function tripEvents(data = {}, { space, member = null, days: withDays = true, alarms: withAlarms = true, labels: custom = {} } = {}) {
  const labels = { ...DEFAULT_LABELS, ...custom };
  const zones = new Map();
  const zoneOf = (tz) => {
    if (typeof tz !== 'string' || !tz) return null;
    if (!zones.has(tz)) zones.set(tz, isTimeZone(tz) ? tz : null);
    return zones.get(tz);
  };
  const uid = (kind, id, suffix = '') => `${space}-${kind}${id ? `-${id}` : ''}${suffix}@${DOMAIN}`;
  const meta = data.meta && typeof data.meta === 'object' ? data.meta : {};
  const home = zoneOf(meta.settings?.homeTz);
  const days = live(data.day).sort(byOrder);
  const visits = live(data.visit).filter((visit) => !visit.alt).sort(byOrder);
  const places = new Map(live(data.place).map((place) => [place.id, place]));
  const dayById = new Map(days.map((day) => [day.id, day]));
  const events = [];

  // A day's zone is that of its first visit to a place with one; untimed or free-form items borrow it.
  const visitsByDay = new Map();
  const dayZone = new Map();
  for (const visit of visits) {
    if (!visitsByDay.has(visit.dayId)) visitsByDay.set(visit.dayId, []);
    visitsByDay.get(visit.dayId).push(visit);
    const zone = zoneOf(places.get(visit.placeId)?.tz);
    if (zone && !dayZone.has(visit.dayId)) dayZone.set(visit.dayId, zone);
  }
  // Days without one keep the previous day's zone; days before the first known zone take that one.
  const dated = days.filter((day) => isDate(day.date)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const firstZone = dated.map((day) => dayZone.get(day.id)).find(Boolean);
  let carried = firstZone;
  for (const day of dated) {
    if (dayZone.has(day.id)) carried = dayZone.get(day.id);
    else if (carried) dayZone.set(day.id, carried);
  }
  const dateZone = new Map();
  for (const day of dated) if (dayZone.has(day.id) && !dateZone.has(day.date)) dateZone.set(day.date, dayZone.get(day.id));
  const zoneOn = (date, own) => zoneOf(own) ?? dateZone.get(date) ?? home;

  if (isDate(meta.start)) {
    events.push({
      uid: uid('trip'), summary: text(meta.title) || text(meta.name) || labels.trip(), ...allDay(meta.start, meta.end),
      transparent: true, modified: meta.upd, alarms: withAlarms ? tripAlarms(meta.reminderDays) : [],
    });
  }

  days.forEach((day, index) => {
    if (!isDate(day.date)) return;
    const untimed = [];
    for (const visit of visitsByDay.get(day.id) ?? []) {
      const place = visit.placeId ? places.get(visit.placeId) : null;
      const name = text(place?.name) || text(visit.title);
      if (!isTime(visit.start)) { if (name) untimed.push(name); continue; }
      const zone = zoneOf(place?.tz) ?? dayZone.get(day.id) ?? home;
      let end = null;
      if (isTime(visit.end)) {
        const endDay = visit.endDayId ? dayById.get(visit.endDayId) : null;
        let date = isDate(endDay?.date) ? endDay.date : day.date;
        if (!endDay && visit.end < visit.start) date = addDays(day.date, 1);
        end = { date, time: visit.end };
      }
      const dwell = Number.isInteger(visit.dwell) && visit.dwell > 0 ? visit.dwell : DEFAULT_MINUTES;
      events.push({
        uid: uid('visit', visit.id), summary: name || labels.visit(), location: text(place?.address) || text(place?.name),
        modified: visit.upd, ...span({ date: day.date, time: visit.start, tz: zone }, end, dwell),
      });
    }
    if (withDays) {
      events.push({
        uid: uid('day', day.id), summary: labels.day(index + 1, text(day.title)), description: untimed.join('\n'),
        ...allDay(day.date), transparent: true, modified: day.upd,
      });
    }
  });

  for (const res of live(data.res)) {
    if (res.status === 'cancelled') continue;
    const base = { status: res.status === 'confirmed' ? 'CONFIRMED' : undefined, modified: res.upd };
    const title = text(res.title);
    const legs = isTransport(res.type) && Array.isArray(res.legs) ? res.legs.filter((leg) => leg && typeof leg === 'object') : [];
    if (legs.length) {
      let alarmed = false;
      legs.forEach((leg, index) => {
        const dep = leg.dep ?? {};
        const arr = leg.arr ?? {};
        if (!isDate(dep.date)) return;
        const route = [leg.from, leg.to].map((end) => text(end?.code) || text(end?.name)).filter(Boolean).join(' → ');
        const generated = [[text(leg.carrier), text(leg.number)].filter(Boolean).join(' '), route].filter(Boolean).join(' · ');
        const single = legs.length === 1;
        const event = {
          ...base, uid: uid('res', res.id, `-${index}`),
          summary: (single ? title || generated : generated || title) || labels.type(res.type),
          description: title && generated ? (single ? generated : title) : '',
          location: text(leg.from?.name) || text(leg.from?.code),
        };
        if (isTime(dep.time)) {
          const start = { date: dep.date, time: dep.time, tz: zoneOn(dep.date, leg.from?.tz) };
          const end = isTime(arr.time) ? { date: isDate(arr.date) ? arr.date : dep.date, time: arr.time, tz: zoneOf(leg.to?.tz) } : null;
          events.push({ ...event, ...span(start, end), alarms: withAlarms && !alarmed ? [{ before: LEAD[res.type] ?? BOOKING_LEAD }] : [] });
          alarmed = true;
        } else events.push({ ...event, ...allDay(dep.date, arr.date), transparent: true });
      });
      continue;
    }
    const location = text(res.location?.address) || text(res.location?.name);
    const summary = title || text(res.location?.name) || labels.type(res.type);
    if (isLodging(res.type)) {
      const from = dayById.get(res.stay?.fromDayId)?.date;
      const to = dayById.get(res.stay?.toDayId)?.date;
      const [first, last] = isDate(from) && isDate(to) ? [from, to] : [res.start?.date, res.end?.date];
      if (!isDate(first)) continue;
      const checkIn = isTime(res.start?.time) ? res.start.time : res.stay?.checkInFrom;
      const checkOut = isTime(res.end?.time) ? res.end.time : res.stay?.checkOut;
      const description = [isTime(checkIn) && labels.checkIn(labels.time(checkIn)), isTime(checkOut) && labels.checkOut(labels.time(checkOut))].filter(Boolean).join('\n');
      events.push({ ...base, uid: uid('res', res.id), summary, location, description, ...allDay(first, last), transparent: true });
      continue;
    }
    const start = res.start;
    if (!isDate(start?.date)) continue;
    const event = { ...base, uid: uid('res', res.id), summary, location };
    if (isTime(start.time)) {
      const end = isDate(res.end?.date) && isTime(res.end?.time) ? { date: res.end.date, time: res.end.time, tz: zoneOf(res.end.tz) } : null;
      events.push({
        ...event, ...span({ date: start.date, time: start.time, tz: zoneOn(start.date, start.tz) }, end),
        alarms: withAlarms ? [{ before: LEAD[res.type] ?? BOOKING_LEAD }] : [],
      });
    } else events.push({ ...event, ...allDay(start.date, res.end?.date), transparent: true });
  }

  const assignees = new Map();
  for (const list of live(data.listMeta)) {
    if (list.kind === 'todo') assignees.set(normName(list.name), Array.isArray(list.assignees) ? list.assignees : []);
  }
  for (const todo of live(data.todo)) {
    if (todo.done || !isDate(todo.due) || !mineOrUnassigned(todo, member, assignees)) continue;
    events.push({
      uid: uid('todo', todo.id), summary: labels.todo(text(todo.name)), ...allDay(todo.due), transparent: true, modified: todo.upd,
      alarms: withAlarms ? [{ before: -MORNING }] : [],
    });
  }
  // What is still to pay on part-paid (or unpaid) expenses with a due date.
  if (meta.settings?.addons?.costs !== false) {
    for (const exp of live(data.exp)) {
      if (!isDate(exp.due) || !Number.isSafeInteger(exp.amount) || !isCurrency(exp.currency) || !Array.isArray(exp.payers)) continue;
      const left = exp.amount - exp.payers.reduce((sum, payer) => sum + (Number.isSafeInteger(payer?.amount) ? payer.amount : 0), 0);
      if (left <= 0 || left > Math.abs(exp.amount)) continue;
      events.push({
        uid: uid('due', exp.id), summary: labels.payment(text(exp.name), labels.money(left, exp.currency)), ...allDay(exp.due), transparent: true, modified: exp.upd,
        alarms: withAlarms ? [{ before: -MORNING }] : [],
      });
    }
  }
  return events;
}

/** Groups snapshot entities (`{t, …}`) into the shape `tripEvents` reads. */
export function tripData(ents = []) {
  const data = { meta: null, day: [], visit: [], place: [], res: [], todo: [], listMeta: [], exp: [] };
  for (const entity of Array.isArray(ents) ? ents : []) {
    if (!entity || entity.deleted) continue;
    if (entity.t === 'meta') data.meta = entity;
    else if (Object.hasOwn(data, entity.t)) data[entity.t].push(entity);
  }
  return data;
}
