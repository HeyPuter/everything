// Pure filtering, sorting and per-user reads for the places pool.

export const SCOPES = Object.freeze(['all', 'unplanned', 'planned', 'tracks']);
export const SORTS = Object.freeze(['recent', 'name', 'rating']);

export const normalize = (value) => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();

/** Average of every member's 1–5 rating, ignoring values another client wrote out of range. */
export function averageRating(place) {
  const values = Object.values(place?.rating ?? {}).filter((value) => Number.isInteger(value) && value >= 1 && value <= 5);
  return values.length ? { avg: values.reduce((sum, value) => sum + value, 0) / values.length, count: values.length } : { avg: 0, count: 0 };
}
export const myRating = (place, uid) => {
  const value = place?.rating?.[uid];
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : 0;
};
/** Only the caller's own tags; other members' tags are readable but never shown. */
export const myTags = (place, uid) => (Array.isArray(place?.tags?.[uid]) ? place.tags[uid].filter((tag) => typeof tag === 'string' && tag.trim()) : []);
export const isVisited = (place, uid) => place?.visited?.[uid] === true;
export const hasLocation = (place) => Number.isFinite(place?.lat) && Number.isFinite(place?.lng);
/** Coordinates always print with a decimal point, so they paste back anywhere. */
export const coordText = ({ lat, lng }) => `${Number(lat.toFixed(6))}, ${Number(lng.toFixed(6))}`;

/**
 * Day ids a place is planned on, from visits grouped by `placeId` (multi-day visits count on their end day too).
 * Stops in a Plan B (`visit.alt`) are not part of the plan.
 */
export function plannedDays(placeId, visitsByPlace) {
  const days = new Set();
  for (const visit of visitsByPlace?.get(placeId) ?? []) {
    if (visit.deleted || visit.alt) continue;
    days.add(visit.dayId);
    if (visit.endDayId) days.add(visit.endDayId);
  }
  return days;
}

/** The caller's tags across places plus `extra` (their personal tags), most used first. */
export function tagVocabulary(places, uid, extra = []) {
  const counts = new Map();
  for (const place of places) for (const tag of myTags(place, uid)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  for (const tag of extra) if (!counts.has(tag)) counts.set(tag, 0);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag);
}

/**
 * `scope` planned/unplanned looks at the open `day` when there is one, otherwise at any day.
 * `cats` is a Set of category ids (empty = all) matched against `categoryKey(place)`, which maps unknown ids to "other";
 * `minRating` compares the average; `tag` is one of the caller's tags.
 */
export function filterPlaces(places, { query = '', scope = 'all', day = null, cats = null, minRating = 0, tag = null, uid, visitsByPlace, categoryKey = (place) => place.cat ?? 'other', categoryName = () => '' } = {}) {
  const words = normalize(query).split(' ').filter(Boolean);
  const tagKey = tag ? normalize(tag) : null;
  return places.filter((place) => {
    if (cats?.size && !cats.has(categoryKey(place))) return false;
    if (scope === 'tracks' && !place.track) return false;
    if (scope === 'planned' || scope === 'unplanned') {
      const days = plannedDays(place.id, visitsByPlace);
      const planned = day ? days.has(day) : days.size > 0;
      if (planned !== (scope === 'planned')) return false;
    }
    if (minRating && averageRating(place).avg < minRating) return false;
    const tags = myTags(place, uid);
    if (tagKey && !tags.some((entry) => normalize(entry) === tagKey)) return false;
    if (!words.length) return true;
    const haystack = normalize([place.name, place.address, place.notes, place.desc, categoryName(place.cat), ...tags].filter(Boolean).join(' '));
    return words.every((word) => haystack.includes(word));
  });
}

export function sortPlaces(places, sort = 'recent') {
  const list = [...places];
  const byName = (a, b) => (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' });
  if (sort === 'name') return list.sort(byName);
  if (sort === 'rating') return list.sort((a, b) => averageRating(b).avg - averageRating(a).avg || averageRating(b).count - averageRating(a).count || byName(a, b));
  return list.sort((a, b) => (b.cr ?? 0) - (a.cr ?? 0) || (a.id < b.id ? 1 : -1));
}
