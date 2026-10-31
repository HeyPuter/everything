// Import planning: turns a parsed trip export or geo file into entity drafts `{t, id, put|set}` for `space.apply`.
// Every id is new, references follow their targets, people outside the target trip become guests, and per-user
// fields keep only the importing user's entry. Each draft is validated with the shared operation rules.
import { isId, isUuid, newId } from '../../shared/ids.js';
import { linkKey } from '../../shared/file-links.js';
import { isOrder, orderKeys } from '../../shared/order.js';
import { validateOperation } from '../../shared/operations.js';
import { validateEntity } from '../../shared/schema/index.js';
import { ROAD_PREFS_ID } from '../../shared/schema/trip.js';
import { plainObject } from '../../shared/schema/dsl.js';
import { meters } from './geo.js';
import { categoryFor } from './symbols.js';
import { cleanLine } from './text.js';
import { trackFeature } from './track-file.js';
import { IO_LIMITS } from './limits.js';

export const IMPORT_GROUPS = Object.freeze({
  plan: Object.freeze(['day', 'alt', 'visit', 'dayNote', 'via', 'dayEnd', 'dayTrack', 'rtPrefs']),
  places: Object.freeze(['place', 'cat']),
  bookings: Object.freeze(['res']),
  costs: Object.freeze(['exp', 'settle', 'splitPreset', 'costCat']),
  lists: Object.freeze(['pack', 'bag', 'todo', 'listMeta']),
  collab: Object.freeze(['note', 'link', 'poll']),
});
export const GROUP_ACTIONS = Object.freeze({ plan: 'plan.edit', places: 'plan.edit', bookings: 'res.edit', costs: 'costs.edit', lists: 'lists.edit', collab: 'collab.post' });
const CREATE_ORDER = ['cat', 'guest', 'day', 'alt', 'place', 'res', 'visit', 'dayNote', 'bag', 'listMeta', 'pack', 'todo', 'exp', 'settle', 'splitPreset', 'costCat', 'note', 'link', 'poll', 'via', 'dayEnd', 'dayTrack'];
const REKEY = ['day', 'alt', 'pack', 'todo', 'bag', 'listMeta', 'costCat', 'exp'];
const SELF = Object.freeze({ place: ['rating', 'visited', 'tags'], pack: ['doneBy', 'bring'], poll: ['votes'] });
const NOT_IMPORTED = ['msg', 'file'];

const norm = (value) => (typeof value === 'string' ? value.trim().toLocaleLowerCase() : '');
const located = (value) => Number.isFinite(value?.lat) && Number.isFinite(value?.lng);

/** Entity counts per import group, plus messages, files and tracks that are not imported as entities. */
export function groupCounts(data) {
  const counts = {};
  for (const [group, types] of Object.entries(IMPORT_GROUPS)) counts[group] = types.reduce((sum, type) => sum + (data.entities[type]?.length ?? 0), 0);
  counts.private = (data.private.pack?.length ?? 0) + (data.private.exp?.length ?? 0);
  counts.chat = data.entities.msg?.length ?? 0;
  counts.files = (data.entities.file ?? []).filter((file) => file.kind !== 'track').length;
  counts.tracks = Object.keys(data.tracks ?? {}).length;
  return counts;
}

/** Index of an existing place with the same name within 100 m (or both unlocated), else undefined. */
export function duplicateOf(candidate, places) {
  const name = norm(candidate.name);
  if (!name) return undefined;
  return places.find((place) => !place.deleted && norm(place.name) === name && (located(candidate) && located(place)
    ? meters([candidate.lng, candidate.lat], [place.lng, place.lat]) <= 100 : !located(candidate) && !located(place)))?.id;
}

function people(list, person) {
  if (!Array.isArray(list)) return undefined;
  const out = [...new Set(list.map(person).filter(Boolean))];
  return out.length ? out : undefined;
}

function check(draft, makeId) {
  try { validateOperation({ opId: makeId(), ...draft }, { kind: 'trip' }); return true; } catch { return false; }
}

/**
 * Plans a trip import. `data` comes from `parseSpaceExport`. Options:
 * - `uid`: the importing user; `mode`: `new` (an empty trip owned by `uid`) or `merge` (the open trip);
 * - `groups`: import groups to take (default all); `can(action)`: permission check for the target trip;
 * - `target`: `{members: [{uid}], guests, places, orders: {type: maxOrderKey}, rtPrefs}` of the open trip (merge);
 * - `formerName(n)`: guest name for a referenced person the export does not name.
 * Returns `{drafts, tracks: [{placeId, fileId, color, km, feature}], private: {pack, exp}, skipped, created, deduped}`.
 */
export function planSpaceImport(data, { uid, mode = 'new', groups = Object.keys(IMPORT_GROUPS), can = () => true, target = {}, makeId = newId, now = Date.now(), formerName = (n) => `Former member ${n}`, catIcons = null } = {}) {
  const chosen = new Set(groups.filter((group) => Object.hasOwn(IMPORT_GROUPS, group) && can(GROUP_ACTIONS[group])));
  const types = new Set([...chosen].flatMap((group) => IMPORT_GROUPS[group]));
  const skipped = {};
  const skip = (type, count = 1) => { if (count) skipped[type] = (skipped[type] ?? 0) + count; };
  for (const [group, list] of Object.entries(IMPORT_GROUPS)) if (!chosen.has(group)) for (const type of list) skip(type, data.entities[type]?.length ?? 0);
  for (const type of NOT_IMPORTED) skip(type, data.entities[type]?.length ?? 0);

  // Pass 1: new ids for everything that will be created; merged places map to the existing place.
  const ids = new Map(CREATE_ORDER.map((type) => [type, new Map()]));
  let deduped = 0;
  const existingPlaces = mode === 'merge' ? (target.places ?? []) : [];
  for (const type of CREATE_ORDER) {
    if (type === 'guest' || !types.has(type)) continue;
    for (const entity of data.entities[type] ?? []) {
      const same = type === 'place' ? duplicateOf(entity, existingPlaces) : undefined;
      if (same) { deduped += 1; ids.get(type).set(entity.id, { id: same, existing: true }); } else ids.get(type).set(entity.id, { id: makeId() });
    }
  }
  const ref = (type, old) => (isId(old) ? ids.get(type)?.get(old)?.id ?? null : null);

  // People: the importer and the target's members stay; anyone else becomes a guest, created when first referenced.
  const members = new Set([uid, ...(target.members ?? []).map((member) => member.uid ?? member.id)]);
  const exportMembers = new Map((data.members ?? []).map((member) => [member.id, member]));
  const exportGuests = new Map((data.entities.guest ?? []).map((guest) => [guest.id, guest]));
  const guestsByName = new Map((target.guests ?? []).filter((guest) => !guest.deleted).map((guest) => [norm(guest.name), guest.id]));
  const canGuests = can('plan.edit');
  const guestDrafts = [];
  const personMap = new Map();
  let former = 0;
  function guestFor(name, color) {
    const key = norm(name);
    if (guestsByName.has(key)) return guestsByName.get(key);
    if (!canGuests) return null;
    const id = makeId();
    const put = { name, ...(Number.isInteger(color) && color >= 1 && color <= 8 ? { color } : {}) };
    guestDrafts.push({ t: 'guest', id, put });
    guestsByName.set(key, id);
    return id;
  }
  function person(value) {
    if (personMap.has(value)) return personMap.get(value);
    let result = null;
    if (isUuid(value)) {
      if (members.has(value)) result = value;
      else {
        const member = exportMembers.get(value);
        result = guestFor(cleanLine(member?.name) || formerName(++former), member?.color);
      }
    } else if (isId(value) && exportGuests.has(value)) {
      const guest = exportGuests.get(value);
      result = guestFor(guest.name, guest.color);
    }
    personMap.set(value, result);
    return result;
  }

  // Merged lists and days go after what the target already has.
  const orders = new Map();
  if (mode === 'merge') {
    for (const type of REKEY) {
      const list = (data.entities[type] ?? []).filter((entity) => types.has(type) && isOrder(entity.order) && ids.get(type).has(entity.id));
      const sorted = [...list].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
      const after = isOrder(target.orders?.[type]) ? target.orders[type] : null;
      const keys = sorted.length ? orderKeys(sorted.length, after, null) : [];
      sorted.forEach((entity, index) => orders.set(`${type}:${entity.id}`, keys[index]));
    }
  }

  const exportPlaces = new Map((data.entities.place ?? []).map((place) => [place.id, place]));
  const tracks = [];
  function remap(type, entity) {
    const { id: _id, ...source } = entity;
    const put = structuredClone(source);
    const rekey = orders.get(`${type}:${entity.id}`);
    if (rekey) put.order = rekey;
    for (const field of SELF[type] ?? []) {
      if (!plainObject(put[field])) continue;
      if (Object.hasOwn(put[field], uid)) put[field] = { [uid]: put[field][uid] }; else delete put[field];
    }
    const setRef = (field, refType, { nullable = false } = {}) => {
      if (!Object.hasOwn(put, field) || put[field] === null) return;
      const mapped = ref(refType, put[field]);
      if (mapped) put[field] = mapped; else if (nullable) put[field] = null; else delete put[field];
    };
    const setPeople = (field) => { if (!Object.hasOwn(put, field)) return; const list = people(put[field], person); if (list) put[field] = list; else delete put[field]; };
    switch (type) {
      case 'place': {
        if (typeof put.cat === 'string' && isId(put.cat)) setRef('cat', 'cat');
        if (put.img?.fileId) delete put.img;
        if (put.track) {
          const feature = data.tracks?.[put.track.fileId];
          if (feature) tracks.push({ placeId: ref('place', entity.id), fileId: put.track.fileId, color: put.track.color, km: put.track.km, feature });
          else skip('track');
          delete put.track;
        }
        break;
      }
      case 'visit': {
        const day = ref('day', put.dayId);
        if (!day) return null;
        put.dayId = day;
        const place = ref('place', put.placeId);
        if (place) put.placeId = place;
        else if (put.placeId) {
          const name = put.title ?? exportPlaces.get(put.placeId)?.name;
          if (!name) return null;
          put.placeId = null; put.title = name;
        }
        setRef('endDayId', 'day'); setRef('stayId', 'res');
        // A visit of an alternative plan that is not imported joins the main plan.
        if (put.alt) { const mapped = ref('alt', put.alt); if (mapped) put.alt = mapped; else delete put.alt; }
        setPeople('people');
        break;
      }
      case 'dayNote': { const day = ref('day', put.dayId); if (!day) return null; put.dayId = day; break; }
      case 'alt': if (put.dayId) { const day = ref('day', put.dayId); if (!day) return null; put.dayId = day; } break;
      case 'res': {
        setRef('placeId', 'place', { nullable: true }); setRef('visitId', 'visit', { nullable: true }); setRef('stayId', 'res', { nullable: true });
        if (put.stay) {
          for (const field of ['fromDayId', 'toDayId']) { if (put.stay[field]) { const day = ref('day', put.stay[field]); if (day) put.stay[field] = day; else delete put.stay[field]; } }
          if (put.stay.toDayId && !put.stay.fromDayId) delete put.stay.toDayId;
        }
        if (put.dayPos) {
          const next = {};
          for (const [day, key] of Object.entries(put.dayPos)) { const mapped = ref('day', day); if (mapped) next[mapped] = key; }
          if (Object.keys(next).length) put.dayPos = next; else delete put.dayPos;
        }
        setPeople('people');
        break;
      }
      case 'exp': {
        put.payers = put.payers.map((payer) => ({ ...payer, who: person(payer.who) }));
        if (put.payers.some((payer) => !payer.who)) return null;
        put.split = { ...put.split, parts: put.split.parts.map((part) => ({ ...part, who: person(part.who) })) };
        if (put.split.parts.some((part) => !part.who)) return null;
        if (put.split.items) {
          put.split.items = put.split.items.map((item) => ({ ...item, who: [...new Set(item.who.map(person))] }));
          if (put.split.items.some((item) => item.who.some((who) => !who))) return null;
        }
        if (put.links) {
          const links = put.links.map((link) => ({ t: link.t, id: ref(link.t, link.id) })).filter((link) => link.id);
          if (links.length) put.links = links; else delete put.links;
        }
        if (typeof put.cat === 'string' && isId(put.cat)) setRef('cat', 'cat');
        break;
      }
      case 'settle': { put.from = person(put.from); put.to = person(put.to); if (!put.from || !put.to) return null; break; }
      case 'splitPreset': {
        const weights = {};
        for (const [who, weight] of Object.entries(put.weights)) { const mapped = person(who); if (mapped) weights[mapped] = weight; }
        put.weights = weights;
        break;
      }
      case 'pack': {
        if (put.bagId) setRef('bagId', 'bag', { nullable: true });
        setPeople('for');
        if (put.vis === 'people' && !put.for) put.vis = 'shared';
        if (put.owner !== undefined && put.owner !== uid) delete put.owner;
        break;
      }
      case 'bag': setPeople('people'); break;
      case 'listMeta': setPeople('assignees'); break;
      case 'todo': if (put.who) put.who = person(put.who); break;
      case 'note': case 'link': case 'poll': {
        if (put.author !== undefined && put.author !== uid) delete put.author;
        if (type === 'poll' && put.deadline != null && put.deadline <= now) { delete put.deadline; put.closed = true; }
        break;
      }
      case 'cat': if (catIcons && !catIcons.includes(put.icon)) put.icon = 'map-pin'; break;
      case 'via': { const day = ref('day', put.dayId); const after = ref('visit', put.after); if (!day || !after) return null; put.dayId = day; put.after = after; break; }
      case 'dayEnd': {
        const day = ref('day', put.day); const from = ref('visit', put.fromVisit); const to = ref('visit', put.toVisit);
        if (!day || !from || !to) return null;
        Object.assign(put, { day, fromVisit: from, toVisit: to });
        break;
      }
      case 'dayTrack': { const day = ref('day', put.dayId); const place = ref('place', put.placeId); if (!day || !place) return null; put.dayId = day; put.placeId = place; break; }
      default: break;
    }
    return put;
  }

  const drafts = [];
  const created = {};
  for (const type of CREATE_ORDER) {
    if (type === 'guest' || !types.has(type)) continue;
    for (const entity of data.entities[type] ?? []) {
      const mapped = ids.get(type).get(entity.id);
      if (!mapped || mapped.existing) continue;
      const put = remap(type, entity);
      const draft = put && { t: type, id: mapped.id, put };
      if (!draft || !check(draft, makeId)) { skip(type); continue; }
      drafts.push(draft);
      created[type] = (created[type] ?? 0) + 1;
    }
  }
  // Road-trip settings are one entity under a fixed id; a merge keeps the target's own and adds the imported days' routes.
  const prefs = types.has('rtPrefs') ? (data.entities.rtPrefs ?? []).find((entity) => entity.id === ROAD_PREFS_ID) : null;
  if (prefs) {
    const { id: _id, dayAvoid, ...fields } = structuredClone(prefs);
    const days = Object.entries(plainObject(dayAvoid) ? dayAvoid : {}).flatMap(([day, avoid]) => { const mapped = ref('day', day); return mapped ? [[mapped, avoid]] : []; });
    const draft = mode === 'merge' && target.rtPrefs
      ? (days.length ? { t: 'rtPrefs', id: ROAD_PREFS_ID, set: Object.fromEntries(days.map(([day, avoid]) => [`dayAvoid.${day}`, avoid])) } : null)
      : { t: 'rtPrefs', id: ROAD_PREFS_ID, put: { ...fields, ...(days.length ? { dayAvoid: Object.fromEntries(days) } : {}) } };
    if (draft && check(draft, makeId)) { drafts.push(draft); created.rtPrefs = 1; } else if (draft) skip('rtPrefs');
  }

  const guests = guestDrafts.filter((draft) => check(draft, makeId));
  if (guests.length) created.guest = guests.length;

  // The importer's own private items; payers and participants must stay themselves.
  const own = { pack: [], exp: [] };
  if (data.exportedBy && data.exportedBy === uid) {
    for (const type of ['pack', 'exp']) {
      for (const item of data.private?.[type] ?? []) {
        const { id: _old, ...fields } = structuredClone(item);
        if (type === 'pack') { delete fields.bagId; delete fields.for; delete fields.vis; delete fields.owner; delete fields.doneBy; delete fields.bring; }
        if (type === 'exp' && fields.links) {
          const links = fields.links.map((link) => ({ t: link.t, id: ref(link.t, link.id) })).filter((link) => link.id);
          if (links.length) fields.links = links; else delete fields.links;
        }
        try { validateEntity('trip', type, fields); own[type].push({ id: makeId(), fields }); } catch { skip(`private.${type}`); }
      }
    }
  } else skip('private', (data.private?.pack?.length ?? 0) + (data.private?.exp?.length ?? 0));

  const placeIds = new Set(drafts.filter((draft) => draft.t === 'place').map((draft) => draft.id));
  return { drafts: [...guests, ...drafts], tracks: tracks.filter((track) => placeIds.has(track.placeId)), private: own, skipped, created, deduped };
}

/**
 * Puts uploaded tracks into the planned places: `uploaded` maps the export's track file id (or the place id for geo
 * imports) to the new file id. Adds file link patches so each track file points at its place.
 */
export function withTracks(drafts, tracks, uploaded, { linkFiles = true } = {}) {
  const byPlace = new Map();
  for (const track of tracks) {
    const fileId = uploaded.get(track.fileId ?? track.placeId);
    if (fileId) byPlace.set(track.placeId, { fileId, ...(track.color !== undefined ? { color: track.color } : {}), ...(Number.isFinite(track.km) ? { km: Math.min(track.km, 100_000) } : {}) });
  }
  const out = drafts.map((draft) => (draft.t === 'place' && byPlace.has(draft.id) ? { ...draft, put: { ...draft.put, track: byPlace.get(draft.id) } } : draft));
  if (linkFiles) for (const [placeId, track] of byPlace) out.push({ t: 'file', id: track.fileId, set: { [`linked.${linkKey({ t: 'place', id: placeId })}`]: true } });
  return out;
}

/** Splits drafts into commit-sized batches. */
export function batches(drafts, size = IO_LIMITS.batch) {
  const out = [];
  for (let i = 0; i < drafts.length; i += size) out.push(drafts.slice(i, i + size));
  return out;
}

/** Display names for geo items: their own, or `names.waypoint(n)` / `names.track(n)` numbered among unnamed ones. */
export function itemNames(items, names = {}) {
  let waypoints = 0; let lines = 0;
  return items.map((item) => item.name || (item.kind === 'track' ? names.track?.(++lines) ?? 'Track' : names.waypoint?.(++waypoints) ?? 'Waypoint'));
}

/**
 * Plans a geo import into the open trip. `items` come from `readGeoFile`; `selected` lists item indices.
 * `context`: `{cats, builtins, dayId, dayAfter (last order key on that day), names: {waypoint(n), track(n)}}`.
 * Returns `{drafts, tracks: [{placeId, feature, color, km}]}`; tracks must be uploaded, then passed to `withTracks`.
 */
export function planGeoImport(items, selected, { makeId = newId, cats = [], builtins = new Map(), dayId = null, dayAfter = null, names = {} } = {}) {
  const drafts = [];
  const tracks = [];
  const placeIds = [];
  const labels = itemNames(items, names);
  for (const index of selected) {
    const item = items[index];
    if (!item) continue;
    const name = labels[index];
    const id = makeId();
    const put = { name, src: item.format === 'kmz' ? 'kml' : item.format };
    if (item.kind === 'track') { put.lat = item.start[1]; put.lng = item.start[0]; } else { put.lat = item.lat; put.lng = item.lng; }
    if (item.desc) put.desc = item.desc;
    if (item.web) put.web = item.web;
    if (item.address) put.address = item.address;
    if (item.phone) put.phone = item.phone;
    const cat = item.kind === 'waypoint' ? categoryFor([item.category, item.sym, item.type], { builtins, cats }) : undefined;
    if (cat) put.cat = cat;
    const draft = { t: 'place', id, put };
    if (!check(draft, makeId)) continue;
    drafts.push(draft);
    placeIds.push(id);
    if (item.kind === 'track') tracks.push({ placeId: id, feature: trackFeature({ ...item, name }), color: item.color, km: item.km });
  }
  if (dayId && placeIds.length) {
    const keys = orderKeys(placeIds.length, isOrder(dayAfter) ? dayAfter : null, null);
    placeIds.forEach((placeId, i) => drafts.push({ t: 'visit', id: makeId(), put: { dayId, placeId, order: keys[i] } }));
  }
  return { drafts, tracks };
}
