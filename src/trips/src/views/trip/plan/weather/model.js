import { daysBetween, isDate, isTimeZone, zonedParts } from '../../../../shared/dates.js';
import { dayStays } from '../../../../lib/res/index.js';

/** Days ahead (after today at the place) that the forecast provider covers; later days use climate normals. */
export const FORECAST_DAYS = 9;
/** Forecast hours a future day needs before it replaces the normals (the last forecast day is often partial). */
export const MIN_FORECAST_HOURS = 12;
const HOUR = 3_600_000;
const SEVERITY = ['clear', 'partly', 'cloudy', 'fog', 'drizzle', 'rain', 'sleet', 'snow', 'thunder'];
const REGION = /^[A-Z]{2}-[A-Z0-9]{1,6}(?:-[A-Z0-9]{1,6})?$/;

const located = (value) => Number.isFinite(value?.lat) && Number.isFinite(value?.lng)
  && value.lat >= -90 && value.lat <= 90 && value.lng >= -180 && value.lng <= 180;
const country = (value) => (typeof value === 'string' && /^[A-Z]{2}$/.test(value) ? value : null);
const region = (value, cc) => (typeof value === 'string' && REGION.test(value) && (!cc || value.startsWith(`${cc}-`)) ? value : null);

/** Forecast cache key: the provider's own rounding (4 decimals). */
export const locationKey = (point) => `${point.lat.toFixed(4)},${point.lng.toFixed(4)}`;
/** Normals cache key: the 0.5° climatology cell and the month. */
export const normalsKey = (point, month) => `${Math.round(point.lat * 2) / 2},${Math.round(point.lng * 2) / 2}:${month}`;

/** A whole-hour zone from the longitude, for places without a known zone. */
export function zoneFromLongitude(lng) {
  const hours = Math.max(-12, Math.min(14, Math.round(lng / 15)));
  return hours === 0 ? 'UTC' : `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`;
}
export const todayIn = (zone, now = Date.now()) => zonedParts(Math.trunc(now), isTimeZone(zone) ? zone : 'UTC').date;

function placePoint(place, source, fallbackName) {
  if (!located(place)) return null;
  return { lat: place.lat, lng: place.lng, name: place.name ?? fallbackName ?? '', tz: isTimeZone(place.tz) ? place.tz : null,
    cc: country(place.cc), region: region(place.admin1, country(place.cc)), source };
}
function stayPoint(res, place) {
  const linked = res.placeId ? placePoint(place(res.placeId), 'stay', res.title) : null;
  if (linked) return { ...linked, tz: linked.tz ?? (isTimeZone(res.start?.tz) ? res.start.tz : null) };
  if (!located(res.location)) return null;
  return { lat: res.location.lat, lng: res.location.lng, name: res.location.name ?? res.title ?? '', tz: isTimeZone(res.start?.tz) ? res.start.tz : null, cc: null, region: null, source: 'stay' };
}
// A transport row is where it arrives, except the departure day of a multi-day leg.
function bookingPoint(row, place) {
  const res = row.entity;
  if (res.status === 'cancelled') return null;
  if (row.leg !== null && res.legs?.[row.leg]) {
    const leg = res.legs[row.leg];
    const end = row.phase === 'start' || row.phase === 'middle' ? leg.from : leg.to;
    return located(end) ? { lat: end.lat, lng: end.lng, name: end.name ?? end.code ?? res.title ?? '', tz: isTimeZone(end.tz) ? end.tz : null, cc: null, region: null, source: 'booking' } : null;
  }
  const linked = res.placeId ? placePoint(place(res.placeId), 'booking', res.title) : null;
  if (linked) return linked;
  return located(res.location) ? { lat: res.location.lat, lng: res.location.lng, name: res.location.name ?? res.title ?? '', tz: isTimeZone(res.start?.tz) ? res.start.tz : null, cc: null, region: null, source: 'booking' } : null;
}

/**
 * Where each day's weather and holidays come from: tonight's stay, else this morning's, else the first located visit,
 * else the first located booking. A day with none borrows the previous located day, else the next one (`from`).
 * `countries` are the ISO codes of that location and every place on the day. `resolved` maps `locationKey` to
 * `{cc, admin1}` (or a country code) found for locations missing a country or region: from the bundled boundaries,
 * else reverse geocoding. Returns `Map<dayId, {location, countries, needsCountry, needsRegion}>`.
 */
export function dayLocations({ days, timeline, reservations, place, resolved = new Map() }) {
  const out = new Map();
  for (const entry of timeline.days) {
    const dayId = entry.day.id;
    const { wake, sleep } = dayStays(reservations, days, dayId);
    let location = null;
    for (const res of [sleep, wake]) if (!location && res) location = stayPoint(res, place);
    const countries = new Set();
    for (const res of [sleep, wake]) { const cc = res?.placeId ? country(place(res.placeId)?.cc) : null; if (cc) countries.add(cc); }
    for (const row of entry.rows) {
      if (row.kind === 'visit') {
        const target = row.entity.placeId ? place(row.entity.placeId) : null;
        if (!location) location = placePoint(target, 'visit');
        const cc = country(target?.cc);
        if (cc) countries.add(cc);
      }
    }
    if (!location) for (const row of entry.rows) if (!location && row.kind === 'res') location = bookingPoint(row, place);
    if (location?.cc) countries.add(location.cc);
    const key = location ? locationKey(location) : null;
    const found = location && (!location.cc || !location.region) ? resolved.get(key) : null;
    if (found) {
      const cc = location.cc ?? country(typeof found === 'string' ? found : found.cc);
      location = { ...location, cc, region: location.region ?? region(found.admin1, cc) };
      if (cc) countries.add(cc);
    }
    const asked = Boolean(location) && resolved.has(key);
    out.set(dayId, {
      location, countries: [...countries].sort(),
      needsCountry: Boolean(location && !countries.size && !asked), needsRegion: Boolean(location?.cc && !location.region && !asked),
    });
  }
  // Borrow from neighbours: the place you stayed at last, or the first one ahead.
  const order = timeline.days.map((entry) => entry.day.id);
  const borrow = (index, step) => {
    for (let at = index + step; at >= 0 && at < order.length; at += step) {
      const other = out.get(order[at]);
      if (other.location) return { id: order[at], ...other };
    }
    return null;
  };
  const filled = new Map(out);
  order.forEach((dayId, index) => {
    const own = out.get(dayId);
    if (own.location && own.countries.length) return;
    const near = borrow(index, -1) ?? borrow(index, 1);
    if (!near) return;
    if (!own.location) filled.set(dayId, { location: { ...near.location, from: near.id }, countries: near.countries, needsCountry: false });
    else if (!own.countries.length && !own.needsCountry) filled.set(dayId, { ...own, countries: near.countries });
  });
  return filled;
}

function localHour(epoch, zone) {
  const { time } = zonedParts(epoch, zone);
  return Number(time.slice(0, 2)) + Number(time.slice(3, 5)) / 60;
}

/**
 * Forecast entries grouped into local days: `Map<date, {date, minC, maxC, precipitationMm, probability, windMps,
 * condition, hours, entries}>`. `hours` counts forecast time inside the day; overlapping periods count once.
 */
export function forecastDays(entries, zone) {
  const days = new Map();
  const sorted = (entries ?? []).map((entry) => ({ ...entry, at: Date.parse(entry.time) }))
    .filter((entry) => Number.isSafeInteger(entry.at) && Number.isFinite(entry.temperatureC)).sort((a, b) => a.at - b.at);
  let coveredUntil = -Infinity;
  for (const entry of sorted) {
    const { date } = zonedParts(entry.at, zone);
    let day = days.get(date);
    if (!day) {
      day = { date, minC: Infinity, maxC: -Infinity, precipitationMm: null, probability: null, windMps: null, condition: null, hours: 0, entries: [], weights: new Map() };
      days.set(date, day);
    }
    const period = (entry.periodHours ?? 1) * HOUR;
    const fresh = Math.max(0, entry.at + period - Math.max(entry.at, coveredUntil)) / period;
    coveredUntil = Math.max(coveredUntil, entry.at + period);
    const inside = Math.min(period / HOUR, 24 - localHour(entry.at, zone)) * fresh;
    day.hours += inside;
    day.minC = Math.min(day.minC, entry.temperatureC);
    day.maxC = Math.max(day.maxC, entry.temperatureC);
    if (Number.isFinite(entry.precipitationMm)) day.precipitationMm = (day.precipitationMm ?? 0) + entry.precipitationMm * fresh;
    if (Number.isFinite(entry.precipitationProbability)) day.probability = Math.max(day.probability ?? 0, entry.precipitationProbability);
    if (Number.isFinite(entry.windMps)) day.windMps = Math.max(day.windMps ?? 0, entry.windMps);
    if (entry.condition) day.weights.set(entry.condition, (day.weights.get(entry.condition) ?? 0) + Math.max(inside, 0.01));
    day.entries.push(entry);
  }
  for (const day of days.values()) {
    day.condition = [...day.weights].sort((a, b) => b[1] - a[1] || SEVERITY.indexOf(b[0]) - SEVERITY.indexOf(a[0]))[0]?.[0] ?? null;
    if (day.precipitationMm !== null) day.precipitationMm = Math.round(day.precipitationMm * 10) / 10;
    day.hours = Math.round(day.hours * 10) / 10;
    delete day.weights;
  }
  return days;
}

/** Up to 12 forecast points for the local day, at least two hours apart: `[{time: 'HH:mm', ...entry}]`. */
export function dayStrip(day, zone) {
  const out = [];
  let last = -Infinity;
  for (const entry of day?.entries ?? []) {
    if (entry.at < last + 2 * HOUR - 60_000) continue;
    const { time } = zonedParts(entry.at, zone);
    if (entry.periodHours === 1 && Number(time.slice(0, 2)) % 2 === 1) continue;
    out.push({ ...entry, local: time });
    last = entry.at;
    if (out.length === 12) break;
  }
  return out;
}

export const inForecastWindow = (date, today) => isDate(date) && isDate(today) && daysBetween(today, date) >= 0 && daysBetween(today, date) <= FORECAST_DAYS;

/**
 * Forecast or normals for one day. `forecast` is the `forecastDays` map, null when unavailable, undefined while loading;
 * `normals` likewise. Past days and days beyond the window use normals, as does a future day the forecast covers for
 * fewer than `MIN_FORECAST_HOURS` (today takes whatever is left of it).
 * Returns `{kind: 'forecast', day}`, `{kind: 'normals', normals}`, `{kind: 'pending', needs}` or `{kind: 'none'}`.
 */
export function chooseWeather({ date, today, forecast, normals }) {
  if (!isDate(date)) return { kind: 'none' };
  if (inForecastWindow(date, today)) {
    if (forecast === undefined) return { kind: 'pending', needs: 'forecast' };
    const day = forecast?.get(date);
    if (day && (date === today ? day.hours > 0 : day.hours >= MIN_FORECAST_HOURS)) return { kind: 'forecast', day };
  }
  if (normals === undefined) return { kind: 'pending', needs: 'normals' };
  return normals ? { kind: 'normals', normals } : { kind: 'none' };
}

/** Calendar years the dated days touch. */
export function tripYears(dates) {
  return [...new Set(dates.filter(isDate).map((date) => Number(date.slice(0, 4))))].sort();
}

/**
 * Holidays on one date for the given countries. `publicList(cc, year)` and `schoolList(cc, year)` return the provider
 * lists (or null/undefined); `regionFor(cc)` the chosen ISO 3166-2 region or null. Regional entries without a chosen
 * region are flagged `unresolved` (one school entry per country). Returns `{public: [...], school: [...]}`.
 */
export function holidaysOn({ date, countries, publicList, schoolList, regionFor }) {
  const result = { public: [], school: [] };
  if (!isDate(date)) return result;
  const year = Number(date.slice(0, 4));
  for (const cc of countries) {
    const chosen = region(regionFor(cc), cc);
    const seen = new Set();
    for (const holiday of publicList(cc, year) ?? []) {
      if (holiday.date !== date || seen.has(holiday.name)) continue;
      const regions = holiday.regions ?? [];
      if (holiday.global || !regions.length) result.public.push({ cc, name: holiday.name, localName: holiday.localName ?? holiday.name, regional: false });
      else if (chosen && regions.includes(chosen)) result.public.push({ cc, name: holiday.name, localName: holiday.localName ?? holiday.name, regional: true, region: chosen });
      else if (!chosen) result.public.push({ cc, name: holiday.name, localName: holiday.localName ?? holiday.name, regional: true, unresolved: true, regions });
      else continue;
      seen.add(holiday.name);
    }
    let unresolved = null;
    for (const period of schoolList(cc, year) ?? []) {
      if (!(period.start <= date && date <= period.end) || seen.has(`school:${period.name}`)) continue;
      const regions = period.regions ?? [];
      if (!regions.length) result.school.push({ cc, name: period.name, regional: false });
      else if (chosen && regions.includes(chosen)) result.school.push({ cc, name: period.name, regional: true, region: chosen });
      else if (!chosen) { unresolved ??= { cc, name: period.name, regional: true, unresolved: true, regions: [] }; unresolved.regions = [...new Set([...unresolved.regions, ...regions])]; continue; }
      else continue;
      seen.add(`school:${period.name}`);
    }
    if (unresolved) result.school.push(unresolved);
  }
  return result;
}

/** True when any regional public or school holiday of `cc` falls within the trip's dates. */
export function regionMatters({ cc, dates, publicList, schoolList }) {
  const sorted = dates.filter(isDate).sort();
  if (!sorted.length) return false;
  const [first, last] = [sorted[0], sorted.at(-1)];
  for (const year of tripYears(sorted)) {
    if ((publicList(cc, year) ?? []).some((holiday) => !holiday.global && holiday.regions?.length && holiday.date >= first && holiday.date <= last)) return true;
    if ((schoolList(cc, year) ?? []).some((period) => period.regions?.length && period.start <= last && period.end >= first)) return true;
  }
  return false;
}

/** Region choices for a picker: the provider's subdivisions, else the region codes seen in the holiday data. */
export function regionOptions({ cc, subdivisions, publicLists = [], schoolLists = [] }) {
  if (subdivisions?.length) return subdivisions.filter((item) => region(item.code, cc)).map((item) => ({ code: item.code, name: item.name || item.code }));
  const codes = new Set();
  for (const list of [...publicLists, ...schoolLists]) for (const item of list ?? []) for (const code of item.regions ?? []) if (region(code, cc)) codes.add(code);
  return [...codes].sort().map((code) => ({ code, name: code }));
}

