// Pure journey logic: ordering, grouping, search, stats, the gallery and suggestions from linked trips.
import { isDate, isTime, daysBetween } from '../../shared/dates.js';
import { isOrder, orderBetween, orderKeys } from '../../shared/order.js';
import { distanceMeters } from '../../shared/geo.js';
import { ENTRY_LIMITS, META_LIMITS } from './constants.js';

export const isSuggestion = (entry) => entry?.type === 'suggestion';
export const sameRef = (a, b) => Boolean(a && b && a.w === b.w && a.s === b.s);
const located = (loc) => Number.isFinite(loc?.lat) && Number.isFinite(loc?.lng);
const fold = (text) => String(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/** Day summaries first, then timed entries by time, then the rest by `order`. */
export function compareEntries(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const rank = (entry) => (entry.type === 'day' ? 0 : isTime(entry.time) ? 1 : 2);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (rank(a) === 1 && a.time !== b.time) return a.time < b.time ? -1 : 1;
  if ((a.order ?? '') !== (b.order ?? '')) return (a.order ?? '') < (b.order ?? '') ? -1 : 1;
  return (a.cr ?? 0) - (b.cr ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Entries the timeline shows: suggestions unless hidden, dismissed ones only when asked, matching `query`.
 * `newestFirst` reverses the day order; entries inside a day keep their order.
 */
export function visibleEntries(entries, { query = '', hideSuggestions = false, showDismissed = false, newestFirst = false } = {}) {
  const needle = fold(query.trim());
  // Two members importing at once can suggest one visit twice; show it once.
  const suggested = new Set();
  const list = entries.filter((entry) => {
    if (!isDate(entry.date)) return false;
    if (entry.dismissed) return showDismissed;
    if (isSuggestion(entry)) {
      if (hideSuggestions) return false;
      const key = entry.src?.visitId ? `${entry.src.trip?.w}/${entry.src.trip?.s}/${entry.src.visitId}` : null;
      if (key && suggested.has(key)) return false;
      if (key) suggested.add(key);
    }
    return !needle || matches(entry, needle);
  }).sort(compareEntries);
  return newestFirst ? reverseDays(list) : list;
}

function reverseDays(list) {
  return groupByDate(list).reverse().flatMap((group) => group.entries);
}

/** True when the folded `needle` appears in the title, story, place, tags, pros or cons. */
export function matches(entry, needle) {
  const text = [entry.title, entry.story, entry.loc?.name, ...(entry.tags ?? []), ...(entry.pros ?? []), ...(entry.cons ?? [])].map(fold).join('\n');
  return text.includes(needle);
}

/** `[{date, entries}]` in the order the entries come in. */
export function groupByDate(entries) {
  const groups = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (last?.date === entry.date) last.entries.push(entry);
    else groups.push({ date: entry.date, entries: [entry] });
  }
  return groups;
}

/**
 * The day the timeline opens on: today when it has entries; inside the journey's span, the closest earlier day;
 * otherwise the first day (a finished or future journey starts at the beginning).
 */
export function openingDate(dates, today) {
  const sorted = [...new Set(dates.filter(isDate))].sort();
  if (!sorted.length) return null;
  if (!isDate(today) || today < sorted[0] || today > sorted.at(-1)) return sorted[0];
  return sorted.filter((date) => date <= today).at(-1);
}

/** `upcoming`, `ongoing` or `completed` for a date span relative to today; null without dates. */
export function statusFor(start, end, today) {
  if (!isDate(today) || (!isDate(start) && !isDate(end))) return null;
  if (isDate(start) && today < start) return 'upcoming';
  if (isDate(end) && today > end) return 'completed';
  return 'ongoing';
}

/** Written entries in story order: no suggestions and nothing dismissed. */
export const writtenEntries = (entries) => entries.filter((entry) => isDate(entry.date) && !entry.dismissed && !isSuggestion(entry)).sort(compareEntries);

/** Points for the dashed route between located written entries, in story order. */
export function connector(entries) {
  return writtenEntries(entries).filter((entry) => located(entry.loc)).map((entry) => [entry.loc.lng, entry.loc.lat]);
}

const words = (text) => (String(text ?? '').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;

/**
 * Totals over written entries not excluded from stats: entries, days, places, countries, photos, words, the
 * distance along the route, mood and weather counts, top tags and the first and last day.
 */
export function journeyStats(entries, { isPhoto = () => true } = {}) {
  const counted = writtenEntries(entries).filter((entry) => !entry.excluded);
  const days = new Set();
  const places = new Set();
  const countries = new Set();
  const photos = new Set();
  const moods = {};
  const weather = {};
  const tags = new Map();
  let wordCount = 0;
  let meters = 0;
  let previous = null;
  for (const entry of counted) {
    days.add(entry.date);
    if (entry.loc?.name) places.add(fold(entry.loc.name));
    else if (located(entry.loc)) places.add(`${entry.loc.lat.toFixed(3)},${entry.loc.lng.toFixed(3)}`);
    if (entry.loc?.cc) countries.add(entry.loc.cc);
    for (const id of entry.media ?? []) if (isPhoto(id)) photos.add(id);
    if (entry.mood) moods[entry.mood] = (moods[entry.mood] ?? 0) + 1;
    if (entry.weather) weather[entry.weather] = (weather[entry.weather] ?? 0) + 1;
    for (const tag of entry.tags ?? []) {
      const key = fold(tag.trim());
      const item = tags.get(key) ?? { tag: tag.trim(), count: 0 };
      item.count += 1;
      tags.set(key, item);
    }
    wordCount += words(entry.story) + words(entry.title);
    if (located(entry.loc)) {
      if (previous) meters += distanceMeters(previous, entry.loc);
      previous = entry.loc;
    }
  }
  const sortedDays = [...days].sort();
  return {
    entries: counted.length, days: days.size, places: places.size, countries: [...countries].sort(), photos: photos.size, words: wordCount,
    meters: Math.round(meters), moods, weather,
    tags: [...tags.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)).slice(0, 12),
    first: sortedDays[0] ?? null, last: sortedDays.at(-1) ?? null,
    span: sortedDays.length ? daysBetween(sortedDays[0], sortedDays.at(-1)) + 1 : 0,
  };
}

/**
 * Photos in story order: `[{fileId, entry}]` for each media id `isImage(fileId)` accepts, each file once.
 * Suggestions and dismissed entries contribute nothing.
 */
export function galleryItems(entries, isImage, { newestFirst = false } = {}) {
  const seen = new Set();
  const items = [];
  const list = writtenEntries(entries);
  for (const entry of newestFirst ? reverseDays(list) : list) {
    for (const fileId of entry.media ?? []) {
      if (seen.has(fileId) || !isImage(fileId)) continue;
      seen.add(fileId);
      items.push({ fileId, entry });
    }
  }
  return items;
}

/** The meta for a new journey made from a trip. */
export function journeyMetaFromTrip(tripMeta, ref, today) {
  const title = [...String(tripMeta?.title ?? '').trim()].slice(0, META_LIMITS.title).join('') || 'Journey';
  const meta = { title, trips: [{ w: ref.w, s: ref.s, k: 'trip' }], fields: { mood: true, weather: true, prosCons: true } };
  const status = statusFor(tripMeta?.start, tripMeta?.end, today);
  if (status) meta.status = status;
  if (tripMeta?.cover && typeof tripMeta.cover === 'object' && typeof tripMeta.cover.url === 'string') {
    meta.cover = { url: tripMeta.cover.url, ...(typeof tripMeta.cover.credit === 'string' ? { credit: tripMeta.cover.credit } : {}) };
  }
  return meta;
}

/** Keys that identify where an entry came from, so a trip visit is suggested once even after it was written up. */
export function sourceKeys(entries) {
  const keys = new Set();
  for (const entry of entries) {
    const src = entry.src;
    if (!src?.trip) continue;
    const trip = `${src.trip.w}/${src.trip.s}`;
    if (src.visitId) keys.add(`${trip}:v:${src.visitId}`);
    if (src.placeId && isDate(entry.date)) keys.add(`${trip}:p:${src.placeId}:${entry.date}`);
  }
  return keys;
}

const clip = (text, max) => [...String(text ?? '')].slice(0, max).join('');

/**
 * Suggestion entries for a linked trip: one per scheduled visit on a dated day, in day order, skipping visits already
 * suggested (`existing`, dismissed and written-up included), Plan B alternatives and repeat visits on one day. `trip`
 * is `{ref, days, visits, places}`; returns entry fields without ids, with `order` keys after `after(date)`.
 */
export function suggestionsFromTrip(trip, existing = [], { after = () => null } = {}) {
  const ref = { w: trip.ref.w, s: trip.ref.s, k: 'trip' };
  const tripKey = `${ref.w}/${ref.s}`;
  const seen = sourceKeys(existing);
  const places = new Map((trip.places ?? []).filter((place) => place && !place.deleted).map((place) => [place.id, place]));
  const byDay = new Map();
  for (const visit of trip.visits ?? []) {
    if (!visit || visit.deleted || visit.alt || typeof visit.dayId !== 'string') continue;
    if (!byDay.has(visit.dayId)) byDay.set(visit.dayId, []);
    byDay.get(visit.dayId).push(visit);
  }
  const days = (trip.days ?? []).filter((day) => day && !day.deleted && isDate(day.date)).sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  const out = [];
  for (const day of days) {
    const visits = (byDay.get(day.id) ?? []).sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
    const fresh = [];
    for (const visit of visits) {
      const place = visit.placeId ? places.get(visit.placeId) : null;
      if (visit.placeId && !place) continue;
      const title = clip((place?.name ?? visit.title ?? '').trim(), ENTRY_LIMITS.title);
      if (!title) continue;
      const visitKey = `${tripKey}:v:${visit.id}`;
      const placeKey = place ? `${tripKey}:p:${place.id}:${day.date}` : null;
      if (seen.has(visitKey) || (placeKey && seen.has(placeKey))) continue;
      seen.add(visitKey);
      if (placeKey) seen.add(placeKey);
      const fields = { type: 'suggestion', date: day.date, title, src: { trip: ref, visitId: visit.id, ...(place ? { placeId: place.id } : {}) } };
      if (isTime(visit.start)) fields.time = visit.start;
      if (place) {
        const loc = {};
        if (place.name) loc.name = clip(place.name, 500);
        if (Number.isFinite(place.lat) && Number.isFinite(place.lng)) Object.assign(loc, { lat: place.lat, lng: place.lng });
        if (typeof place.cc === 'string' && /^[A-Z]{2}$/.test(place.cc)) loc.cc = place.cc;
        if (Object.keys(loc).length) fields.loc = loc;
      }
      fresh.push(fields);
    }
    const keys = orderKeys(fresh.length, after(day.date));
    fresh.forEach((fields, index) => out.push({ ...fields, order: keys[index] }));
  }
  return out;
}

/** Suggestions from one trip that nobody touched yet (still a suggestion, not dismissed), for unlinking. */
export function untouchedSuggestions(entries, ref) {
  return entries.filter((entry) => isSuggestion(entry) && !entry.dismissed && sameRef(entry.src?.trip, ref) && !entry.story && !(entry.media ?? []).length);
}

/** The last `order` used on each date, for appending. */
export function lastOrders(entries) {
  const last = new Map();
  for (const entry of entries) {
    if (!isDate(entry.date) || typeof entry.order !== 'string') continue;
    if (!last.has(entry.date) || entry.order > last.get(entry.date)) last.set(entry.date, entry.order);
  }
  return last;
}

/** Entries whose place in a day comes from `order` (not day summaries, not timed ones), in display order. */
export const orderedSiblings = (entries, date) => entries.filter((entry) => entry.date === date && entry.type !== 'day' && !isTime(entry.time) && !entry.dismissed).sort(compareEntries);

/**
 * `[{id, order}]` writes that move `siblings[index]` one step (`delta` -1 or 1). Keys between the new neighbours
 * when they are distinct; otherwise every sibling gets a fresh key.
 */
export function moveOrder(siblings, index, delta) {
  const target = index + delta;
  if (index < 0 || index >= siblings.length || target < 0 || target >= siblings.length) return [];
  const rest = siblings.filter((_, at) => at !== index);
  const left = rest[target - 1]?.order ?? null;
  const right = rest[target]?.order ?? null;
  if ((left === null || isOrder(left)) && (right === null || isOrder(right)) && (left === null || right === null || left < right)) {
    return [{ id: siblings[index].id, order: orderBetween(left, right) }];
  }
  rest.splice(target, 0, siblings[index]);
  const keys = orderKeys(rest.length);
  return rest.map((entry, at) => ({ id: entry.id, order: keys[at] })).filter((item, at) => rest[at].order !== item.order);
}

/** Normalized tag list: trimmed, case-insensitively distinct, within the worker's limits. */
export function cleanTags(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const tag = clip(String(value ?? '').trim(), ENTRY_LIMITS.tag);
    const key = fold(tag);
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= ENTRY_LIMITS.tags) break;
  }
  return out;
}

/** Normalized pros or cons: trimmed, non-blank, within the worker's limits. */
export function cleanList(values) {
  return values.map((value) => clip(String(value ?? '').trim(), ENTRY_LIMITS.item)).filter(Boolean).slice(0, ENTRY_LIMITS.list);
}

/** The journey weather value for a forecast condition (services/weather.js `CONDITIONS`). */
export function weatherFromCondition(condition, windSpeed = 0) {
  if (Number(windSpeed) >= 10.8 && ['clear', 'partly', 'cloudy'].includes(condition)) return 'wind';
  return { clear: 'clear', partly: 'partly', cloudy: 'cloudy', fog: 'fog', drizzle: 'rain', rain: 'rain', sleet: 'snow', snow: 'snow', thunder: 'thunder' }[condition] ?? null;
}
