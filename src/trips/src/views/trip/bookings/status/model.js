// Flight status display logic: which flight a leg is, when to ask, and what a provider answer means for the leg.
import { addDays, daysBetween, isDate, isTime, isTimeZone, zonedParts } from '../../../../shared/dates.js';
import { zonedEpoch } from '../../../../lib/res/time.js';
import { validDesignator } from '../../../../services/flights.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Delays shorter than this read as on time (the usual airline threshold). */
export const DELAY_MINUTES = 15;
/** Status is fetched by itself from this long before departure until this long after arrival. */
export const LIVE_BEFORE = 3 * DAY;
export const LIVE_AFTER = 6 * HOUR;
const AIRBORNE = new Set(['departed', 'enroute', 'approaching']);

const compact = (value) => (typeof value === 'string' ? value.toUpperCase().replace(/[\s.-]/g, '') : '');
const airlineCode = (value) => (/^(?:[A-Z]{3}|[A-Z0-9]{2})$/.test(value) && /[A-Z]/.test(value) ? value : null);
const canonical = (code, digits) => `${code}${digits.replace(/^0+(?=\d)/, '')}`;

/**
 * The flight designator (`KL1395`) of a leg: from a number that carries its airline code ("KL 1395", "KLM1395"),
 * or from a bare number plus a carrier that is a code or names one in brackets ("KLM (KL)"). Null otherwise.
 */
export function flightDesignator(leg) {
  const number = compact(leg?.number);
  const full = number.match(/^([A-Z]{3}|[A-Z0-9]{2})(\d{1,4}[A-Z]?)$/);
  if (full && airlineCode(full[1])) return canonical(full[1], full[2]);
  if (!/^\d{1,4}[A-Z]?$/.test(number)) return null;
  const carrier = typeof leg?.carrier === 'string' ? leg.carrier.toUpperCase() : '';
  const code = airlineCode(compact(carrier)) ?? airlineCode(carrier.match(/\(([A-Z0-9]{2,3})\)/)?.[1] ?? '');
  const designator = code ? canonical(code, number) : null;
  return designator && validDesignator(designator) ? designator : null;
}

/** `{number, date}` for the flight-status service, or null when the leg has no designator or departure date. */
export function statusQuery(leg) {
  const number = flightDesignator(leg);
  return number && isDate(leg?.dep?.date) ? { number, date: leg.dep.date } : null;
}
export const queryId = (query) => `${query.number}:${query.date}`;

// A leg point as an instant; untimed points span their whole local day.
function bound(point, zone, end) {
  if (!isDate(point?.date)) return null;
  const tz = isTimeZone(zone) ? zone : 'UTC';
  if (isTime(point.time)) return zonedEpoch(point.date, point.time, tz);
  return zonedEpoch(end ? addDays(point.date, 1) : point.date, '00:00', tz) - (end ? MINUTE : 0);
}
/** `early` (more than three days out), `live`, `past` (six hours after arrival) or `none` (no departure date). */
export function statusWindow(leg, now) {
  const dep = bound(leg?.dep, leg?.from?.tz, false);
  if (dep === null) return 'none';
  const arr = bound(leg?.arr?.date ? leg.arr : leg.dep, leg?.arr?.date ? leg?.to?.tz : leg?.from?.tz, true) ?? dep;
  if (dep - now > LIVE_BEFORE) return 'early';
  if (Math.max(arr, dep) + LIVE_AFTER < now) return 'past';
  return 'live';
}

const iata = (end) => (typeof end?.code === 'string' && /^[A-Z]{3}$/.test(end.code.toUpperCase()) ? end.code.toUpperCase() : null);
/**
 * The provider flight matching a leg: same departure and arrival airports, else the same departure, else the only
 * flight. Operating flights win over codeshare listings. Null when the answer is ambiguous.
 */
export function pickFlight(flights, leg) {
  const list = (flights ?? []).filter(Boolean).sort((a, b) => Number(a.codeshare) - Number(b.codeshare));
  const from = iata(leg?.from); const to = iata(leg?.to);
  const both = list.find((flight) => from && to && flight.dep?.iata === from && flight.arr?.iata === to);
  if (both) return both;
  const departing = list.filter((flight) => from && flight.dep?.iata === from);
  if (departing.length === 1 || (departing.length && !to)) return departing[0];
  const arriving = list.filter((flight) => to && flight.arr?.iata === to && (!from || !flight.dep?.iata));
  if (arriving.length === 1) return arriving[0];
  return list.length === 1 && !(from && list[0].dep?.iata && list[0].dep.iata !== from) ? list[0] : null;
}

/** Local `{date, time, tz}` of an instant at an airport: its zone, else the leg's, else the offset the provider gave. */
export function localAt(epoch, side, fallbackZone) {
  if (!Number.isFinite(epoch)) return null;
  const zone = isTimeZone(side?.tz) ? side.tz : isTimeZone(fallbackZone) ? fallbackZone : null;
  if (zone) { const parts = zonedParts(epoch, zone); return { date: parts.date, time: parts.time, tz: zone }; }
  const shifted = new Date(epoch + (Number.isFinite(side?.offset) ? side.offset : 0) * MINUTE).toISOString();
  return { date: shifted.slice(0, 10), time: shifted.slice(11, 16), tz: null, offset: side?.offset ?? 0 };
}

/** The most current time for one end of a flight and where it comes from. */
export function bestTime(side) {
  if (!side) return null;
  if (Number.isFinite(side.runway)) return { at: side.runway, kind: 'actual' };
  if (Number.isFinite(side.revised)) return { at: side.revised, kind: 'revised' };
  if (Number.isFinite(side.predicted)) return { at: side.predicted, kind: 'predicted' };
  return Number.isFinite(side.scheduled) ? { at: side.scheduled, kind: 'scheduled' } : null;
}
/** Minutes between the schedule and the most current time, or null without both. */
export function delayMinutes(side) {
  const current = bestTime(side);
  if (!current || current.kind === 'scheduled' || !Number.isFinite(side.scheduled)) return null;
  return Math.round((current.at - side.scheduled) / MINUTE);
}

function sideView(side, booked, zone) {
  if (!side) return null;
  const current = bestTime(side);
  const scheduled = localAt(side.scheduled, side, zone);
  const now = current && current.kind !== 'scheduled' ? localAt(current.at, side, zone) : null;
  let retimed = null;
  // Same local zone on both sides, so wall-clock minutes are elapsed minutes.
  if (scheduled && isDate(booked?.date) && isTime(booked?.time)) {
    const minutes = daysBetween(booked.date, scheduled.date) * 1440 + (toMinutes(scheduled.time) - toMinutes(booked.time));
    if (Math.abs(minutes) >= 5 && Math.abs(minutes) < 2 * 1440) retimed = { minutes, booked: { date: booked.date, time: booked.time } };
  }
  return {
    airport: side.iata ?? side.name ?? null, name: side.name, scheduled, current: now, kind: current?.kind ?? null,
    delay: delayMinutes(side), shift: scheduled && now ? daysBetween(scheduled.date, now.date) : 0,
    terminal: side.terminal, gate: side.gate, checkIn: side.checkIn, belt: side.belt, retimed,
  };
}
const toMinutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/**
 * What a flight's status means for a leg: `tone` (success|warn|danger|accent|''), `label` `{key, values}` for
 * `flightStatus.*` strings (`values.duration` in minutes, formatted by the view), `phase`, and per-end details with
 * local times in each airport's zone.
 */
export function describeFlight(flight, leg) {
  const dep = sideView(flight.dep, leg?.dep, leg?.from?.tz);
  const arr = sideView(flight.arr, leg?.arr, leg?.to?.tz);
  const depDelay = dep?.delay ?? null; const arrDelay = arr?.delay ?? null;
  const late = (minutes) => minutes !== null && minutes >= DELAY_MINUTES;
  const live = Boolean(flight.dep?.live || flight.arr?.live || (dep?.kind && dep.kind !== 'scheduled') || (arr?.kind && arr.kind !== 'scheduled'));
  let phase = 'scheduled'; let tone = ''; let label;
  switch (flight.status) {
    case 'cancelled': phase = 'cancelled'; tone = 'danger'; label = { key: 'flightStatus.cancelled' }; break;
    case 'uncertain': phase = 'cancelled'; tone = 'warn'; label = { key: 'flightStatus.uncertain' }; break;
    case 'diverted': phase = 'diverted'; tone = 'danger'; label = { key: 'flightStatus.diverted' }; break;
    case 'arrived':
      phase = 'landed';
      tone = late(arrDelay) ? 'warn' : 'success';
      label = late(arrDelay) ? { key: 'flightStatus.landedLate', values: { duration: arrDelay } } : { key: 'flightStatus.landed' };
      break;
    default:
      if (AIRBORNE.has(flight.status)) {
        phase = 'airborne';
        tone = late(arrDelay) ? 'warn' : 'success';
        label = late(arrDelay) ? { key: 'flightStatus.airborneLate', values: { duration: arrDelay } } : { key: 'flightStatus.airborne' };
      } else if (flight.status === 'boarding') {
        phase = 'boarding'; tone = 'accent';
        label = dep?.gate ? { key: 'flightStatus.boardingGate', values: { gate: dep.gate } } : { key: 'flightStatus.boarding' };
      } else if (flight.status === 'gateclosed') {
        phase = 'boarding'; tone = 'warn'; label = { key: 'flightStatus.gateClosed' };
      } else if (late(depDelay)) {
        tone = 'warn'; label = { key: 'flightStatus.delayed', values: { duration: depDelay } };
      } else if (flight.status === 'delayed') {
        tone = 'warn'; label = { key: 'flightStatus.delayedUnknown' };
      } else if (depDelay !== null && depDelay <= -DELAY_MINUTES) {
        tone = 'accent'; label = { key: 'flightStatus.early', values: { duration: -depDelay } };
      } else if (flight.status === 'checkin') {
        tone = 'accent'; label = { key: 'flightStatus.checkIn' };
      } else if (live) {
        tone = 'success'; label = { key: 'flightStatus.onTime' };
      } else label = { key: 'flightStatus.scheduled' };
  }
  return { phase, tone, label, live, dep, arr, depDelay, arrDelay };
}

export const TRACKED = Object.freeze(['depTerminal', 'depGate', 'arrTerminal', 'arrGate', 'belt']);
const fieldsOf = (flight) => ({
  depTerminal: flight?.dep?.terminal ?? null, depGate: flight?.dep?.gate ?? null,
  arrTerminal: flight?.arr?.terminal ?? null, arrGate: flight?.arr?.gate ?? null, belt: flight?.arr?.belt ?? null,
});
/**
 * Remembered terminals, gates and belt after a new answer, with `changes` `{field: {from, to, at}}` against what was
 * seen before. A value the provider stops sending is kept; a change back to the first value clears the change.
 */
export function mergeSeen(previous, flight, now) {
  const before = previous?.fields ?? {};
  const next = fieldsOf(flight);
  const changes = { ...(previous?.changes ?? {}) };
  const fields = { ...before };
  for (const field of TRACKED) {
    const value = next[field];
    if (!value) continue;
    if (before[field] && before[field] !== value) {
      const from = changes[field]?.from ?? before[field];
      if (from === value) delete changes[field];
      else changes[field] = { from, to: value, at: now };
    }
    fields[field] = value;
  }
  return { fields, changes, at: now };
}
/** Changes still worth showing: gates and terminals until the flight leaves, the belt until it is seen again. */
export function visibleChanges(seen, view) {
  const changes = seen?.changes ?? {};
  const out = {};
  for (const [field, change] of Object.entries(changes)) {
    if (field.startsWith('dep') && ['airborne', 'landed', 'cancelled', 'diverted'].includes(view?.phase)) continue;
    out[field] = change;
  }
  return out;
}
export const seenId = (query, flight) => `${queryId(query)}:${flight?.dep?.iata ?? '-'}-${flight?.arr?.iata ?? '-'}`;
