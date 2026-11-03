import { isUuid } from '../../src/shared/ids.js';
import { fileLinks } from '../../src/shared/file-links.js';
import { isCurrency } from '../../src/shared/money.js';
import { keepsLocation } from './exif.js';
import { projectJourney } from './projection-journey.js';

/** Read-only public views of a snapshot (data-model §6 `GET /pub`). Pure, so every toggle can be tested directly. */

export const PROJECTION_VERSION = 2;
const RASTER = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const TRIP_SECTIONS = Object.freeze({
  plan: ['day', 'visit', 'place', 'dayNote', 'cat'],
  bookings: ['res'],
  packing: ['pack', 'bag', 'listMeta'],
  costs: ['exp', 'settle', 'costCat'],
  chat: ['msg'],
  road: ['rtPrefs', 'via', 'dayEnd'],
});
const ALWAYS = Object.freeze({ trip: ['guest'], collection: ['saved', 'label'] });
const PER_USER = Object.freeze({ place: ['rating', 'tags', 'visited'], saved: ['rating', 'tags', 'visited'], pack: ['doneBy', 'bring'], msg: ['react'], poll: ['votes'] });
const STAMPS = ['by', 'v', 'rev', 'upd'];
const META_PUBLIC = ['title', 'name', 'subtitle', 'description', 'desc', 'start', 'end', 'dayCount', 'currency', 'cover', 'tags', 'color', 'icon'];
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

/** Masks anything shaped like an email address in a display name. */
export const maskEmails = (text) => (typeof text === 'string' ? text.replace(EMAIL, (match) => `${match[0]}…`) : text);
/** Member names are Puter usernames, so public links show only their initial. */
export const initialOf = (name) => { const first = [...(typeof name === 'string' ? name.trim() : '')][0]; return first ? `${first.toLocaleUpperCase()}.` : '?'; };

/** Stable, meaningless stand-ins for member uuids; valid uuids so client code that checks ids keeps working. */
export const aliasId = (index) => `00000000-0000-0000-0000-${index.toString(16).padStart(12, '0')}`;

/** The effective toggles. `map` defaults on for shares made before it existed. */
export function shareView(kind, share, exp = null) {
  const value = share && typeof share === 'object' ? share : {};
  const on = (key) => value[key] === true;
  if (kind === 'trip') {
    const plan = on('plan');
    const bookings = on('bookings');
    return {
      plan, map: value.map !== false && (plan || bookings), bookings, codes: bookings && on('codes'),
      packing: on('packing'), costs: on('costs'), chat: on('chat'), files: on('files'), road: plan && on('road'),
      cur: isCurrency(value.cur) ? value.cur : null, exp,
    };
  }
  if (kind === 'journey') return { timeline: value.timeline !== false, gallery: on('gallery'), map: on('map'), newestFirst: on('newestFirst'), exp };
  return { exp };
}

function visibleTypes(kind, view) {
  const types = [...(ALWAYS[kind] ?? [])];
  if (kind === 'trip') for (const [toggle, list] of Object.entries(TRIP_SECTIONS)) if (view[toggle]) types.push(...list);
  return new Set(types);
}

const dropKeys = (object, keys) => { for (const key of keys) delete object[key]; };
const stripPoint = (point) => {
  if (!point || typeof point !== 'object') return point;
  const { lat: _lat, lng: _lng, address: _address, ...rest } = point;
  return rest;
};

function entityView(entity, kind, view) {
  // Private items live in personal KV; this only guards against one reaching a snapshot by mistake.
  if (entity.private === true) return null;
  const out = structuredClone(entity);
  if (entity.t === 'msg') {
    if (entity.deleted) return null;
    // `author` is optional on older messages; `by` is the worker's attribution.
    if (!isUuid(out.author) && isUuid(entity.by)) out.author = entity.by;
  }
  if (entity.t === 'listMeta' && entity.kind !== 'pack') return null;
  dropKeys(out, STAMPS);
  dropKeys(out, PER_USER[entity.t] ?? []);
  if (entity.t === 'place') {
    delete out.src;
    delete out.track;
    if (!view.map) dropKeys(out, ['lat', 'lng', 'address', 'ids']);
  }
  if (entity.t === 'res') {
    dropKeys(out, ['src', 'review']);
    if (!view.codes) dropKeys(out, ['code', 'notes', 'url']);
    if (!view.map && out.location) out.location = stripPoint(out.location);
    if (Array.isArray(out.legs)) {
      out.legs = out.legs.map((leg) => {
        const next = { ...leg };
        if (!view.codes) delete next.code;
        if (!view.map) { delete next.shape; next.from = stripPoint(next.from); next.to = stripPoint(next.to); }
        return next;
      });
    }
  }
  // Names other trips and their workers.
  if (entity.t === 'exp') delete out.across;
  // A route point is only its coordinates.
  if (entity.t === 'via' && !view.map) return null;
  if (entity.t === 'guest') out.name = maskEmails(out.name);
  // Trip refs name another space and its worker.
  if (entity.t === 'saved') delete out.src;
  return out;
}

export function createAliases(members) {
  const map = new Map();
  for (const member of members) map.set(member.id, aliasId(map.size + 1));
  const alias = (uuid) => {
    if (!map.has(uuid)) map.set(uuid, aliasId(map.size + 1));
    return map.get(uuid);
  };
  const walk = (value) => {
    if (typeof value === 'string') return isUuid(value) ? alias(value) : value;
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [isUuid(key) ? alias(key) : key, walk(item)]));
    return value;
  };
  return { alias, walk };
}

/**
 * `snapshot` is the worker snapshot, `share` the space meta's `share`, `meta` the freshest meta entity (defaults to
 * the snapshot's) and `exp` the effective expiry. Returns the response body without `ok`.
 */
export function project(snapshot, kind, share, { meta: freshMeta, exp = null } = {}) {
  if (kind === 'journey') return projectJourney(snapshot, share, { meta: freshMeta, exp });
  const ents = Array.isArray(snapshot?.ents) ? snapshot.ents.filter((entity) => entity && typeof entity === 'object') : [];
  const view = shareView(kind, share, exp);
  const allowed = visibleTypes(kind, view);
  const metaEntity = freshMeta && typeof freshMeta === 'object' ? freshMeta : ents.find((entity) => entity.t === 'meta') ?? {};
  const meta = Object.fromEntries(META_PUBLIC.filter((field) => Object.hasOwn(metaEntity, field)).map((field) => [field, structuredClone(metaEntity[field])]));
  if (view.road && metaEntity.settings?.addons?.roadtrip === true) meta.settings = { addons: { roadtrip: true } };

  const files = new Map();
  for (const entity of ents) if (entity.t === 'file' && !entity.deleted && !entity.trashed) files.set(entity.id, entity);
  const isImage = (id) => typeof id === 'string' && RASTER.has(files.get(id)?.mime);

  const out = [];
  for (const entity of ents) {
    if (!allowed.has(entity.t) || entity.deleted) continue;
    const item = entityView(entity, kind, view);
    if (item) out.push(item);
  }
  const visible = new Set(out.map((entity) => `${entity.t}:${entity.id}`));
  visible.add('meta:meta');
  const servable = new Set();
  if (typeof meta.cover === 'string') { if (isImage(meta.cover)) servable.add(meta.cover); else delete meta.cover; }
  for (const entity of out) {
    if (typeof entity.img?.fileId !== 'string') continue;
    if (isImage(entity.img.fileId)) servable.add(entity.img.fileId); else delete entity.img;
  }
  if (view.files) {
    for (const file of files.values()) {
      // Without the map, files that may carry a location the worker cannot strip stay private.
      if (!view.map && keepsLocation(file.mime)) continue;
      if (file.kind === 'user' && fileLinks(file).some((link) => visible.has(`${link.t}:${link.id}`))) servable.add(file.id);
    }
  }
  for (const entity of out) if (Array.isArray(entity.links)) entity.links = entity.links.filter((link) => visible.has(`${link?.t}:${link?.id}`));
  const fileViews = [...servable].map((id) => {
    const file = files.get(id);
    const { name, mime, size } = file;
    return { t: 'file', id, name, mime, size, links: fileLinks(file).filter((link) => visible.has(`${link.t}:${link.id}`)) };
  });

  const memberEnts = ents.filter((entity) => entity.t === 'member' && !entity.deleted && isUuid(entity.id))
    .sort((a, b) => (a.cr ?? 0) - (b.cr ?? 0) || (a.id < b.id ? -1 : 1));
  const aliases = createAliases(memberEnts);
  const members = memberEnts.map(({ id, name, color }) => ({ id: aliases.alias(id), name: initialOf(name), ...(color !== undefined ? { color } : {}) }));
  return {
    v: PROJECTION_VERSION, kind, rev: snapshot?.rev ?? 0, at: snapshot?.at ?? 0,
    share: view, meta, members, ents: aliases.walk([...out, ...fileViews]), files: [...servable],
  };
}
