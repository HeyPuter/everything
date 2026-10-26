// Op builders for place and category writes. Each returns ops for `space.apply`; nothing here touches the DOM.
import { fileLinkPatch, fileLinks } from '../../../shared/file-links.js';

const FORM_FIELDS = ['name', 'desc', 'notes', 'address', 'lat', 'lng', 'tz', 'cc', 'admin1', 'cat', 'price', 'web', 'phone', 'img', 'ids', 'src'];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const empty = (value) => value === undefined || value === null || value === '';
const linksTo = (links, ids) => Array.isArray(links) && links.some((link) => link?.t === 'place' && ids.has(link.id));
const without = (links, ids) => links.filter((link) => !(link?.t === 'place' && ids.has(link.id)));

/** Create fields from form values: empty optional fields are left out. */
export function placeFields(values) {
  return Object.fromEntries(FORM_FIELDS.filter((key) => !empty(values[key])).map((key) => [key, structuredClone(values[key])]));
}

/** `{set, unset}` between a stored place and form values; only fields the form owns are compared. */
export function placePatch(before, values) {
  const set = {}; const unset = [];
  for (const key of FORM_FIELDS) {
    if (!Object.hasOwn(values, key)) continue;
    const next = values[key];
    if (empty(next)) { if (!empty(before[key]) && key !== 'name') unset.push(key); continue; }
    if (!same(before[key], next)) set[key] = structuredClone(next);
  }
  return { set, unset };
}

/** Expenses that link any of the places, and whether a place was the last link of each. */
export function linkedExpenses(space, placeIds) {
  const ids = new Set(placeIds);
  return (space.select.exp?.all() ?? []).filter((exp) => linksTo(exp.links, ids)).map((exp) => ({ exp, last: without(exp.links, ids).length === 0 }));
}

/**
 * Deleting places also removes their visits and unlinks them from bookings, files and expenses the caller may edit.
 * Expenses in `deleteExpenses` (ids whose last link was one of these places) are deleted instead of unlinked.
 */
export function deletePlacesOps(space, placeIds, { deleteExpenses = new Set() } = {}) {
  const ids = new Set(placeIds.filter((id) => space.get('place', id)));
  if (!ids.size || !space.can('plan.edit')) return [];
  const ops = [];
  const visits = space.select.visit.groupBy('placeId');
  for (const id of ids) {
    for (const visit of visits.get(id) ?? []) ops.push(space.ops.remove('visit', visit.id));
    ops.push(space.ops.remove('place', id));
  }
  if (space.can('res.edit')) {
    for (const res of space.select.res?.all() ?? []) if (ids.has(res.placeId)) ops.push(space.ops.patch('res', res.id, { unset: ['placeId'] }));
  }
  if (space.can('files.edit')) {
    for (const file of space.select.file?.all() ?? []) {
      const patch = fileLinkPatch(file, { remove: fileLinks(file).filter((link) => link.t === 'place' && ids.has(link.id)) });
      if (patch) ops.push(space.ops.patch('file', file.id, patch));
    }
  }
  if (space.can('costs.edit')) {
    for (const { exp, last } of linkedExpenses(space, [...ids])) {
      ops.push(last && deleteExpenses.has(exp.id) ? space.ops.remove('exp', exp.id, { base: true })
        : space.ops.patch('exp', exp.id, { set: { links: without(exp.links, ids) } }, { base: true }));
    }
  }
  return ops;
}

/** Sets (or clears with `null`) the category of each place whose category differs. */
export function categoryOps(space, placeIds, cat) {
  return placeIds.map((id) => space.get('place', id)).filter((place) => place && (place.cat ?? null) !== (cat ?? null))
    .map((place) => space.ops.patch('place', place.id, cat ? { set: { cat } } : { unset: ['cat'] }));
}

/** The caller's own visited flags (`visited.<uuid>`), which any member may write. */
export function visitedOps(space, placeIds, uid, visited) {
  return placeIds.map((id) => space.get('place', id)).filter((place) => place && (place.visited?.[uid] === true) !== visited)
    .map((place) => space.ops.patch('place', place.id, visited ? { set: { [`visited.${uid}`]: true } } : { unset: [`visited.${uid}`] }));
}

export function ratingOp(space, placeId, uid, value) {
  return value ? space.ops.patch('place', placeId, { set: { [`rating.${uid}`]: value } }) : space.ops.patch('place', placeId, { unset: [`rating.${uid}`] });
}

/** Replaces the caller's tag list, dropping blanks and case-insensitive duplicates. */
export function tagsOp(space, placeId, uid, tags) {
  const seen = new Set();
  const clean = tags.map((tag) => String(tag).replace(/\s+/g, ' ').trim().slice(0, 100)).filter((tag) => tag && !seen.has(tag.toLocaleLowerCase()) && seen.add(tag.toLocaleLowerCase()));
  return clean.length ? space.ops.patch('place', placeId, { set: { [`tags.${uid}`]: clean.slice(0, 100) } }) : space.ops.patch('place', placeId, { unset: [`tags.${uid}`] });
}

/** Deletes a trip category; places that used it lose their category (they read as "Other"). */
export function removeCategoryOps(space, catId) {
  const places = (space.select.place?.all() ?? []).filter((place) => place.cat === catId);
  return [...places.map((place) => space.ops.patch('place', place.id, { unset: ['cat'] })), space.ops.remove('cat', catId)];
}
