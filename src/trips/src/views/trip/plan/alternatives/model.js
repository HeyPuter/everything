// Plan B: alternative versions of a day (`alt.dayId`) or of the whole plan (no `dayId`), stored as `alt` entities
// whose visits carry `visit.alt`. Pure: functions take entity lists and return writes `{t, id, put|set|unset|del}`.
import { isTime, timeMinutes } from '../../../../shared/dates.js';
import { newId } from '../../../../shared/ids.js';
import { orderBetween } from '../../../../shared/order.js';
import { SERVER_FIELDS } from '../../../../shared/schema/index.js';
import { meters } from '../../../../lib/io/geo.js';

const byOrder = (a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const fieldsOf = (entity) => Object.fromEntries(Object.entries(entity).filter(([key]) => !SERVER_FIELDS.includes(key) && key !== 't'));
const minutes = (time) => (isTime(time) ? timeMinutes(time) : null);

/** Alternatives in order; those of a day that no longer exists are left out. */
export function alternatives(alts, days) {
  const ids = new Set(days.map((day) => day.id));
  return alts.filter((alt) => !alt.dayId || ids.has(alt.dayId)).sort(byOrder);
}

/** Alternatives shown for a day: the day's own and the whole-plan ones. */
export const dayAlternatives = (alts, days, dayId) => alternatives(alts, days).filter((alt) => !alt.dayId || alt.dayId === dayId);

/** Main-plan visits that start on `dayId`, in order. */
export const mainStops = (visits, dayId) => visits.filter((visit) => !visit.alt && visit.dayId === dayId).sort(byOrder);

/** An alternative's visits on `dayId` (on every day when omitted), in order. */
export const altStops = (visits, altId, dayId = null) => visits.filter((visit) => visit.alt === altId && (!dayId || visit.dayId === dayId)).sort(byOrder);

/** Days a switch changes: the alternative's day, or every day for a whole-plan alternative. */
export const daysOf = (alt, days) => (alt.dayId ? [alt.dayId] : days.map((day) => day.id));

/** Alternatives worth flagging on a day: its own, and whole-plan ones with stops that day. */
export function flagged(alts, days, visits, dayId) {
  return dayAlternatives(alts, days, dayId).filter((alt) => alt.dayId === dayId || visits.some((visit) => visit.alt === alt.id && visit.dayId === dayId));
}

/** How many alternatives `flagged` reports for each day, in one pass: `Map<dayId, count>`. */
export function flagCounts(alts, days, visits) {
  const shown = alternatives(alts, days);
  const whole = new Set(shown.filter((alt) => !alt.dayId).map((alt) => alt.id));
  const counts = new Map();
  for (const alt of shown) if (alt.dayId) counts.set(alt.dayId, (counts.get(alt.dayId) ?? 0) + 1);
  const seen = new Set();
  for (const visit of visits) {
    const key = `${visit.alt}:${visit.dayId}`;
    if (!whole.has(visit.alt) || seen.has(key)) continue;
    seen.add(key);
    counts.set(visit.dayId, (counts.get(visit.dayId) ?? 0) + 1);
  }
  return counts;
}

/** "Plan B", "Plan C"… for the next alternative among `count` existing ones. */
export const nextLetter = (count) => String.fromCharCode(66 + Math.min(count, 24));

/** A new alternative after the last one; with `copyFrom`, the main plan's visits on its days are copied into it. */
export function createWrites({ alts, days, visits, dayId = null, name, copy = false, makeId = newId }) {
  const last = [...alts].sort(byOrder).at(-1)?.order ?? null;
  const alt = { t: 'alt', id: makeId(), put: { name, order: orderBetween(last, null), ...(dayId ? { dayId } : {}) } };
  const writes = [alt];
  if (copy) {
    const covered = new Set(dayId ? [dayId] : days.map((day) => day.id));
    for (const visit of visits) {
      if (visit.alt || !covered.has(visit.dayId)) continue;
      writes.push({ t: 'visit', id: makeId(), put: { ...fieldsOf(visit), alt: alt.id } });
    }
  }
  return writes;
}

/**
 * Makes `alt` the main plan on its days: main visits move into it and its visits become the main plan, so switching
 * again swaps back. The alternative takes `previousName`, since it now holds the old plan.
 */
export function promoteWrites({ alt, days, visits, previousName }) {
  const covered = new Set(daysOf(alt, days));
  const writes = [];
  for (const visit of visits) {
    if (!covered.has(visit.dayId)) continue;
    if (!visit.alt) writes.push({ t: 'visit', id: visit.id, set: { alt: alt.id } });
    else if (visit.alt === alt.id) writes.push({ t: 'visit', id: visit.id, unset: ['alt'] });
  }
  if (previousName && previousName !== alt.name) writes.push({ t: 'alt', id: alt.id, set: { name: previousName } });
  return writes;
}

/** Deletes an alternative with its visits. */
export function removeWrites({ alt, visits }) {
  return [...altStops(visits, alt.id).map((visit) => ({ t: 'visit', id: visit.id, del: true })), { t: 'alt', id: alt.id, del: true }];
}

/** A stop at the end of `stops` (one plan on one day): a place, or a title without one. */
export function addStopWrite({ stops, dayId, altId = null, placeId = null, title = '', makeId = newId }) {
  const put = { dayId, placeId, order: orderBetween(stops.at(-1)?.order ?? null, null), ...(altId ? { alt: altId } : {}) };
  if (!placeId) put.title = title.trim();
  return { t: 'visit', id: makeId(), put };
}

/** Moves stop `index` one place up (`-1`) or down (`1`) among `stops`, or null at an end. */
export function moveStopWrite(stops, index, delta) {
  const target = index + delta;
  if (target < 0 || target >= stops.length) return null;
  const rest = stops.filter((_, i) => i !== index);
  const left = rest[target - 1]?.order ?? null;
  const right = rest[target]?.order ?? null;
  return { t: 'visit', id: stops[index].id, set: { order: orderBetween(left, right) } };
}

/** A copy of an alternative's stop at the end of the main plan's day. */
export function copyToMainWrite({ visit, visits, makeId = newId }) {
  const { alt: _alt, ...put } = fieldsOf(visit);
  put.order = orderBetween(mainStops(visits, visit.dayId).at(-1)?.order ?? null, null);
  return { t: 'visit', id: makeId(), put };
}

const stopKey = (visit) => (visit.placeId ? `p:${visit.placeId}` : `t:${(visit.title ?? '').trim().toLocaleLowerCase()}`);

/** Stops of `a` with no counterpart (same place, or same title) in `b`: `Set<visitId>`. */
export function onlyIn(a, b) {
  const keys = new Set(b.map(stopKey));
  return new Set(a.filter((visit) => !keys.has(stopKey(visit))).map((visit) => visit.id));
}

/**
 * Figures for comparing plans: `{stops, first, last, planned, meters}`. `first`/`last` are minutes after midnight of
 * the earliest start and latest end (null without times); `planned` sums dwell or start–end spans; `meters` is the
 * straight-line distance between consecutive located stops.
 */
export function planStats(stops, placeOf = () => null) {
  let first = null;
  let last = null;
  let planned = 0;
  let distance = 0;
  let previous = null;
  for (const stop of stops) {
    const start = minutes(stop.start);
    let end = minutes(stop.end);
    const dwell = Number.isInteger(stop.dwell) ? stop.dwell : end !== null && start !== null && end >= start ? end - start : 0;
    if (end === null && start !== null && dwell) end = start + dwell;
    if (start !== null) first = first === null ? start : Math.min(first, start);
    if (end !== null || start !== null) last = Math.max(last ?? 0, end ?? start);
    planned += dwell;
    const place = stop.placeId ? placeOf(stop.placeId) : null;
    if (Number.isFinite(place?.lat) && Number.isFinite(place?.lng)) {
      if (previous) distance += meters([previous.lng, previous.lat], [place.lng, place.lat]);
      previous = place;
    }
  }
  return { stops: stops.length, first, last, planned, meters: Math.round(distance) };
}
