// Dawarich stays beyond the trip (spec §22 [3]): as journey check-ins, and as matches for open bucket-list items.
import { isDate, isTime } from '../../shared/dates.js';
import { orderKeys } from '../../shared/order.js';
import { validateEntity } from '../../shared/schema/index.js';
import { distanceMeters as metersBetween } from '../../shared/geo.js';

export { metersBetween };

const NEAR_METERS = 2000;
const located = (value) => Number.isFinite(value?.lat) && Number.isFinite(value?.lng);

/**
 * Journey check-in entries for stays (`{name, date, time?, lat, lng, cc?}`, oldest first), with order keys after
 * `after`. Stays without a date are skipped; `fallbackTitle` names unnamed ones. Each draft passes the journey schema.
 */
export function journeyEntries(stays, { fallbackTitle, after = null } = {}) {
  const usable = stays.filter((stay) => isDate(stay.date));
  const keys = orderKeys(usable.length, after, null);
  return usable.map((stay, index) => {
    const title = (stay.name || fallbackTitle || '').trim().slice(0, 300) || fallbackTitle;
    const loc = { ...(stay.name ? { name: stay.name.slice(0, 500) } : {}), ...(located(stay) ? { lat: stay.lat, lng: stay.lng } : {}), ...(/^[A-Z]{2}$/.test(stay.cc ?? '') ? { cc: stay.cc } : {}) };
    const fields = { type: 'checkin', date: stay.date, title, order: keys[index], ...(isTime(stay.time) ? { time: stay.time } : {}), ...(Object.keys(loc).length ? { loc } : {}) };
    validateEntity('journey', 'entry', fields);
    return fields;
  });
}

/**
 * Open bucket-list items that stays reached: an item with coordinates by a stay within 2 km, a country-only item by a
 * stay in that country (`locate(lat, lng)` gives the atlas code). `[{item, stay, date}]` with the earliest stay.
 */
export function bucketMatches(stays, items, { locate, radius = NEAR_METERS } = {}) {
  const sorted = stays.filter((stay) => located(stay) && isDate(stay.date)).sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const countries = new Map();
  const countryOf = (stay) => {
    const key = `${stay.lat},${stay.lng}`;
    if (!countries.has(key)) countries.set(key, typeof locate === 'function' ? locate(stay.lat, stay.lng) : null);
    return countries.get(key);
  };
  const out = [];
  for (const item of items) {
    if (!item || item.visitedAt) continue;
    const stay = located(item)
      ? sorted.find((candidate) => metersBetween(item, candidate) <= radius)
      : item.cc ? sorted.find((candidate) => countryOf(candidate) === item.cc) : null;
    if (stay) out.push({ item, stay, date: stay.date });
  }
  return out;
}
