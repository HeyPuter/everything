// Deterministic checks after extraction: airports and zones, local times from absolute instants, leg order, AM/PM slips.
import { addDays, isDate, isTimeZone, timeMinutes, minutesTime, zonedParts } from '../../../shared/dates.js';
import { comparePoints, dayForDate, isTransport, legIssues, legPoints, minutesBetween, rangeIssue, resIssues } from '../../res/index.js';
import { finalize } from './schema.js';

const MAX_LEG_MINUTES = 20 * 60;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const legKey = (leg) => JSON.stringify([leg.from?.code ?? leg.from?.name ?? '', leg.to?.code ?? leg.to?.name ?? '', leg.dep?.date ?? '', leg.dep?.time ?? '', (leg.number ?? '').replace(/\s+/g, '').toUpperCase()]);

async function airportFor(airports, code, cache) {
  if (!airports || !/^[A-Z]{3}$/.test(code ?? '')) return null;
  if (!cache.has(code)) cache.set(code, Promise.resolve().then(() => airports.byCode(code)).catch(() => null));
  return cache.get(code);
}

async function zoneAt(tz, lat, lng) {
  if (!tz || !Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  try { const zone = await tz.zoneAt(lat, lng); return isTimeZone(zone) ? zone : undefined; } catch { return undefined; }
}

function localAt(epoch, zone) {
  if (!Number.isFinite(epoch) || !isTimeZone(zone)) return null;
  const parts = zonedParts(epoch, zone);
  return { date: parts.date, time: parts.time };
}

/**
 * Fixes an arrival that reads earlier than its departure: an overnight arrival kept on the departure date, or a
 * 12-hour time read without its PM. Picks the shortest plausible duration and reports what it changed.
 */
function fixArrival(leg) {
  const { dep, arr } = legPoints(leg);
  const minutes = minutesBetween(dep, arr);
  if (minutes === null || minutes >= 0) return null;
  const options = [];
  if (arr.date === dep.date) options.push({ code: 'arrival_next_day', arr: { ...leg.arr, date: addDays(arr.date, 1) } });
  if (timeMinutes(arr.time) < 12 * 60) options.push({ code: 'ampm_fixed', arr: { ...leg.arr, time: minutesTime(timeMinutes(arr.time) + 12 * 60) } });
  const scored = options.map((option) => ({ ...option, minutes: minutesBetween(dep, legPoints({ ...leg, arr: option.arr }).arr) }))
    .filter((option) => option.minutes !== null && option.minutes > 0 && option.minutes <= MAX_LEG_MINUTES)
    .sort((a, b) => a.minutes - b.minutes);
  return scored[0] ?? null;
}

/**
 * Runs the post-extraction checks on a candidate and returns an updated copy with `warnings`. Uses
 * `services.airports.byCode` (airport names, coordinates and zones), `services.tz.zoneAt` (zones from
 * coordinates) and the trip's days (dates outside the trip). Never throws for a missing service.
 */
export async function checkCandidate(candidate, { services = {}, days = [], fallbackTitle, cache = new Map() } = {}) {
  const draft = structuredClone(candidate.draft);
  const warnings = [];
  const hints = candidate.hints ?? {};
  if (isTransport(draft.type) && draft.legs?.length) {
    for (const [index, leg] of draft.legs.entries()) {
      for (const side of ['from', 'to']) {
        const end = leg[side] ?? {};
        if (draft.type === 'flight' && end.code) {
          const airport = await airportFor(services.airports, end.code, cache);
          if (airport) {
            if (!end.name || end.name.toUpperCase() === end.code) end.name = airport.name;
            Object.assign(end, { lat: airport.lat, lng: airport.lng, tz: airport.tz });
          } else if (services.airports) warnings.push({ code: 'unknown_airport', leg: index, value: end.code });
        } else if (!end.tz) {
          const zone = await zoneAt(services.tz, end.lat, end.lng);
          if (zone) end.tz = zone;
        }
        leg[side] = end;
      }
      // Parser instants are exact; restate them in the endpoint's zone once it is known.
      const hint = hints.legs?.[index];
      const dep = localAt(hint?.depAt, leg.from?.tz);
      if (dep && !same(dep, leg.dep)) leg.dep = dep;
      const arr = localAt(hint?.arrAt, leg.to?.tz);
      if (arr && !same(arr, leg.arr)) leg.arr = arr;
    }
    const seen = new Set();
    const unique = draft.legs.filter((leg) => { const key = legKey(leg); if (seen.has(key)) return false; seen.add(key); return true; });
    if (unique.length < draft.legs.length) warnings.push({ code: 'duplicate_leg' });
    const sorted = unique.map((leg, index) => ({ leg, index })).sort((a, b) => comparePoints(legPoints(a.leg).dep, legPoints(b.leg).dep) || a.index - b.index);
    if (sorted.some((entry, index) => entry.index !== index)) warnings.push({ code: 'legs_reordered' });
    draft.legs = sorted.map((entry) => entry.leg);
    for (const [index, leg] of draft.legs.entries()) {
      const fix = fixArrival(leg);
      if (fix) { leg.arr = fix.arr; warnings.push({ code: fix.code, leg: index }); }
    }
    for (const issue of legIssues(draft.legs)) warnings.push({ code: issue.code, leg: issue.leg });
  } else {
    if (draft.location && !draft.start?.tz) {
      const zone = await zoneAt(services.tz, draft.location.lat, draft.location.lng);
      if (zone && draft.start) { draft.start.tz = zone; if (draft.end) draft.end.tz = zone; }
    }
    const start = localAt(hints.startAt, draft.start?.tz);
    if (start) draft.start = { ...draft.start, ...start };
    const end = localAt(hints.endAt, draft.end?.tz);
    if (end) draft.end = { ...draft.end, ...end };
    if (rangeIssue(draft.start, draft.end)) warnings.push({ code: 'end_before_start' });
  }
  const first = isTransport(draft.type) ? draft.legs?.[0]?.dep?.date : draft.start?.date;
  if (isDate(first) && days.some((day) => isDate(day.date)) && !dayForDate(days, first)) warnings.push({ code: 'outside_trip' });
  const fields = finalize(draft, { provider: candidate.provider, fallbackTitle });
  return { ...candidate, draft: fields, warnings: [...(candidate.warnings ?? []), ...warnings], issues: resIssues(fields) };
}
