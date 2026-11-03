import { isTime, timeMinutes } from '../../shared/dates.js';
import { isCurrency } from '../../shared/money.js';

// The trip's single `rtPrefs` entity always uses this id, so every member edits the same one.
export { ROAD_PREFS_ID } from '../../shared/schema/trip.js';
export const FUELS = Object.freeze(['petrol', 'electric', 'either']);
export const AVOIDS = Object.freeze(['toll', 'motorway', 'ferry']);
export const CORRIDORS = Object.freeze([2, 5, 10]);
// Used when the vehicle gives neither a range nor what is needed to compute one.
export const DEFAULT_RANGE = Object.freeze({ petrol: 600, electric: 350, either: 600 });

export const DEFAULT_PREFS = Object.freeze({
  fuel: 'petrol', range: null, tank: null, use: null, battery: null, degrade: 0, fill: null, reserve: 10,
  price: null, currency: null, start: '08:00', end: '20:00', stint: 120, daily: 480, pause: 20,
  avoid: Object.freeze([]), dayAvoid: Object.freeze({}), corridor: 5, showStops: true,
});

const num = (value, min, max) => (Number.isFinite(value) && value >= min && value <= max ? value : null);
const int = (value, min, max) => (Number.isInteger(value) && value >= min && value <= max ? value : null);
const avoidList = (value) => (Array.isArray(value) ? AVOIDS.filter((item) => value.includes(item)) : []);

/** `rtPrefs` (or null) with every field filled in and out-of-range values replaced by defaults. */
export function readPrefs(entity) {
  const value = entity && typeof entity === 'object' ? entity : {};
  const fuel = FUELS.includes(value.fuel) ? value.fuel : DEFAULT_PREFS.fuel;
  const start = isTime(value.start) ? value.start : DEFAULT_PREFS.start;
  let end = isTime(value.end) ? value.end : DEFAULT_PREFS.end;
  if (timeMinutes(end) <= timeMinutes(start)) end = '23:59';
  const dayAvoid = {};
  if (value.dayAvoid && typeof value.dayAvoid === 'object') {
    for (const [dayId, list] of Object.entries(value.dayAvoid)) if (Array.isArray(list)) dayAvoid[dayId] = avoidList(list);
  }
  return {
    fuel,
    range: num(value.range, 10, 3000),
    tank: num(value.tank, 1, 500),
    use: num(value.use, 0.5, 100),
    battery: num(value.battery, 1, 500),
    degrade: int(value.degrade, 0, 60) ?? 0,
    fill: int(value.fill, 10, 100) ?? (fuel === 'electric' ? 80 : 100),
    reserve: int(value.reserve, 0, 50) ?? DEFAULT_PREFS.reserve,
    price: typeof value.price === 'string' && /^\d{1,6}(?:\.\d{1,6})?$/.test(value.price) && Number(value.price) > 0 ? value.price : null,
    currency: isCurrency(value.currency) ? value.currency : null,
    start, end,
    stint: int(value.stint, 15, 720) ?? DEFAULT_PREFS.stint,
    daily: int(value.daily, 30, 1440) ?? DEFAULT_PREFS.daily,
    pause: int(value.pause, 0, 240) ?? DEFAULT_PREFS.pause,
    avoid: avoidList(value.avoid),
    dayAvoid,
    corridor: int(value.corridor, 1, 50) ?? DEFAULT_PREFS.corridor,
    showStops: value.showStops !== false,
  };
}

/** Kilometres on a full tank or charge: the stated range, else tank ÷ consumption, else battery (less degradation) ÷ consumption. */
export function rangeKm(prefs) {
  if (prefs.range) return prefs.range;
  if (prefs.use) {
    if (prefs.fuel === 'electric' && prefs.battery) return Math.round(prefs.battery * (1 - prefs.degrade / 100) / prefs.use * 100);
    if (prefs.fuel !== 'electric' && prefs.tank) return Math.round(prefs.tank / prefs.use * 100);
  }
  return DEFAULT_RANGE[prefs.fuel];
}

/** Whether the range comes from the vehicle settings rather than the default guess. */
export const rangeKnown = (prefs) => Boolean(prefs.range || (prefs.use && (prefs.fuel === 'electric' ? prefs.battery : prefs.tank)));

/** Stop types that refill this vehicle. */
export function refillTypes(prefs) {
  if (prefs.fuel === 'electric') return ['charge'];
  if (prefs.fuel === 'either') return ['fuel', 'charge'];
  return ['fuel'];
}

/** Corridor search categories that refill this vehicle. */
export const refillCategories = (prefs) => refillTypes(prefs).map((type) => (type === 'charge' ? 'charging' : 'fuel'));

/** Avoid options for a day: its own choice, else the trip default. */
export const dayAvoid = (prefs, dayId) => (Object.hasOwn(prefs.dayAvoid, dayId) ? prefs.dayAvoid[dayId] : prefs.avoid);

/**
 * The write that applies `changes` (field → value, `null` clears) to the stored entity: a create when there is none,
 * otherwise a path patch. Returns `{create}` (fields) or `{set, unset}`, or null when nothing changes.
 */
export function prefsChange(stored, changes) {
  const set = {}; const unset = [];
  for (const [key, value] of Object.entries(changes)) {
    if (!Object.hasOwn(DEFAULT_PREFS, key)) continue;
    if (value === null || value === undefined) { if (stored && Object.hasOwn(stored, key)) unset.push(key); continue; }
    if (JSON.stringify(stored?.[key]) !== JSON.stringify(value)) set[key] = value;
  }
  if (!stored) return Object.keys(set).length ? { create: set } : null;
  return Object.keys(set).length || unset.length ? { set, unset } : null;
}
