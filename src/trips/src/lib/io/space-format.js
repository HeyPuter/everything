// The versioned JSON file for one space (`trips-space`): backup, copy and transfer of a whole trip.
// Exports carry the shared entities, the exporter's own private items and per-user fields, never anyone else's.
import { isId, isUuid } from '../../shared/ids.js';
import { LIMITS } from '../../shared/limits.js';
import { schemas, validateEntity, SERVER_FIELDS } from '../../shared/schema/index.js';
import { plainObject } from '../../shared/schema/dsl.js';
import { IoError } from './errors.js';
import { IO_LIMITS } from './limits.js';
import { cleanTrackFeature } from './track-file.js';
import { cleanLine } from './text.js';

export const SPACE_FORMAT = 'trips-space';
export const SPACE_FORMAT_VERSION = 1;
export const PRIVATE_TYPES = Object.freeze(['pack', 'exp']);
// Per-user maps keyed by member uuid. `tags` are shown only to their owner, so exports keep the exporter's alone.
const PRIVATE_PER_USER = Object.freeze({ place: ['tags'], saved: ['tags'] });
const SKIP_TYPES = new Set(['meta', 'member']);

const strip = (entity) => {
  const out = {};
  for (const [key, value] of Object.entries(entity)) if (!SERVER_FIELDS.includes(key) && key !== 't' && key !== 'deleted' && key !== 'private') out[key] = value;
  return out;
};

function ownOnly(type, fields, uid) {
  const out = structuredClone(fields);
  for (const field of PRIVATE_PER_USER[type] ?? []) {
    if (!plainObject(out[field])) continue;
    if (Object.hasOwn(out[field], uid)) out[field] = { [uid]: out[field][uid] }; else delete out[field];
  }
  return out;
}

/**
 * Builds the export object. `entities` maps type → entity list (server stamps are dropped); `members` are
 * `{id|uid, name, role, color}`; `privateItems` are the exporter's own `{pack, exp}`; `tracks` maps fileId → Feature.
 */
export function buildSpaceExport({ kind = 'trip', meta, entities = {}, members = [], uid, privateItems = {}, tracks = {}, source = {}, includeChat = true, now = Date.now() }) {
  const types = schemas[kind] ?? {};
  const out = {};
  for (const [type, list] of Object.entries(entities)) {
    if (!Object.hasOwn(types, type) || SKIP_TYPES.has(type) || (type === 'msg' && !includeChat)) continue;
    const items = [];
    for (const entity of list ?? []) {
      if (!entity || entity.deleted || typeof entity.id !== 'string') continue;
      const item = { id: entity.id, ...ownOnly(type, strip(entity), uid) };
      if (type === 'msg') { item.at = entity.cr; item.by = entity.by; }
      items.push(item);
    }
    if (items.length) out[type] = items;
  }
  const { share: _share, ...metaFields } = strip(meta ?? {});
  const data = {
    format: SPACE_FORMAT, version: SPACE_FORMAT_VERSION, kind, exportedAt: new Date(now).toISOString(), exportedBy: uid,
    ...(source.space ? { source: { space: source.space, ...(Number.isSafeInteger(source.rev) ? { rev: source.rev } : {}) } } : {}),
    meta: metaFields,
    members: members.map((member) => ({ id: member.id ?? member.uid, name: member.name, role: member.role, ...(member.color !== undefined ? { color: member.color } : {}) }))
      .filter((member) => isUuid(member.id)),
    entities: out,
  };
  const own = {};
  for (const type of PRIVATE_TYPES) {
    const items = (privateItems[type] ?? []).filter((item) => item && typeof item.id === 'string').map((item) => ({ id: item.id, ...strip(item) }));
    if (items.length) own[type] = items;
  }
  if (Object.keys(own).length) data.private = own;
  if (Object.keys(tracks).length) data.tracks = tracks;
  return data;
}

/** The worker's owner export (`space.export`, format `trips-export`) in this format, filtered for `uid`. */
export function fromWorkerExport(raw, { uid, privateItems = {}, now } = {}) {
  const entities = {};
  let meta = {};
  const memberEntities = new Map();
  for (const entity of Array.isArray(raw?.ents) ? raw.ents : []) {
    if (!entity || typeof entity.t !== 'string') continue;
    if (entity.t === 'meta') { meta = entity; continue; }
    if (entity.t === 'member') { memberEntities.set(entity.id, entity); continue; }
    (entities[entity.t] ??= []).push(entity);
  }
  const members = (Array.isArray(raw?.members) ? raw.members : []).map((member) => {
    const entity = memberEntities.get(member.uuid);
    return { id: member.uuid, name: entity?.name ?? member.username ?? '', role: member.role, ...(entity?.color !== undefined ? { color: entity.color } : {}) };
  });
  return buildSpaceExport({ kind: raw?.kind ?? 'trip', meta, entities, members, uid, privateItems, source: { space: raw?.space, rev: raw?.rev }, now });
}

const textSize = (value) => (typeof value === 'string' ? new TextEncoder().encode(value).length : 0);

function checkEntity(kind, type, value, seen) {
  if (!plainObject(value)) return null;
  const { id, ...rest } = value;
  if (!isId(id) || seen.has(id)) return null;
  const fields = strip(rest);
  delete fields.at;
  try { validateEntity(kind, type, fields); } catch { return null; }
  seen.add(id);
  return { id, ...fields };
}

const TRIP_TOTAL = LIMITS.entities;
const TYPE_CAPS = Object.freeze({ day: LIMITS.tripDays, place: LIMITS.places });

/**
 * Reads an export file (text or parsed JSON). Every entity is validated against the shared schema; invalid ones are
 * dropped and counted in `invalid`. Returns `{kind, version, meta, members, entities, private, tracks, exportedBy,
 * exportedAt, invalid, total}`.
 */
export function parseSpaceExport(input) {
  let data = input;
  if (typeof input === 'string') {
    if (textSize(input) > IO_LIMITS.jsonBytes) throw new IoError('file_too_large');
    try { data = JSON.parse(input); } catch { throw new IoError('invalid_json'); }
  }
  if (!plainObject(data)) throw new IoError('not_trip_export');
  if (data.format === 'trips-export') data = fromWorkerExport(data, { uid: null });
  if (data.format !== SPACE_FORMAT) throw new IoError('not_trip_export');
  if (!Number.isSafeInteger(data.version) || data.version < 1) throw new IoError('not_trip_export');
  if (data.version > SPACE_FORMAT_VERSION) throw new IoError('newer_version');
  if (data.kind !== 'trip') throw new IoError('unsupported_kind');
  const meta = cleanMeta(data.meta);
  if (!meta) throw new IoError('not_trip_export');
  const types = schemas.trip;
  const entities = {};
  const invalid = {};
  let total = 0;
  const source = plainObject(data.entities) ? data.entities : {};
  for (const [type, list] of Object.entries(source)) {
    if (!Object.hasOwn(types, type) || SKIP_TYPES.has(type)) { invalid[type] = (invalid[type] ?? 0) + (Array.isArray(list) ? list.length : 1); continue; }
    if (!Array.isArray(list)) { invalid[type] = (invalid[type] ?? 0) + 1; continue; }
    const seen = new Set();
    const kept = [];
    for (const value of list) {
      if (total >= TRIP_TOTAL || kept.length >= (TYPE_CAPS[type] ?? TRIP_TOTAL)) throw new IoError('too_many_items');
      const entity = checkEntity('trip', type, value, seen);
      if (entity) { kept.push(entity); total += 1; } else invalid[type] = (invalid[type] ?? 0) + 1;
    }
    if (kept.length) entities[type] = kept;
  }
  const own = {};
  const privateSource = plainObject(data.private) ? data.private : {};
  for (const type of PRIVATE_TYPES) {
    if (!Array.isArray(privateSource[type])) continue;
    const seen = new Set();
    const kept = [];
    for (const value of privateSource[type].slice(0, 5_000)) {
      const entity = checkEntity('trip', type, value, seen);
      if (entity) kept.push(entity); else invalid[`private.${type}`] = (invalid[`private.${type}`] ?? 0) + 1;
    }
    if (kept.length) own[type] = kept;
  }
  const tracks = {};
  if (plainObject(data.tracks)) {
    for (const [fileId, value] of Object.entries(data.tracks).slice(0, IO_LIMITS.tracks)) {
      const feature = isId(fileId) ? cleanTrackFeature(value) : null;
      if (feature) tracks[fileId] = feature; else invalid.track = (invalid.track ?? 0) + 1;
    }
  }
  const members = (Array.isArray(data.members) ? data.members : []).slice(0, 500).flatMap((member) => {
    if (!plainObject(member) || !isUuid(member.id)) return [];
    const name = cleanLine(member.name);
    return [{ id: member.id, name, role: ['owner', 'editor', 'viewer'].includes(member.role) ? member.role : 'viewer', ...(Number.isInteger(member.color) && member.color >= 1 && member.color <= 8 ? { color: member.color } : {}) }];
  });
  return {
    kind: 'trip', version: data.version, meta, members, entities, private: own, tracks,
    exportedBy: isUuid(data.exportedBy) ? data.exportedBy : null,
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt.slice(0, 40) : null,
    invalid, total,
  };
}

const META_FIELDS = ['title', 'description', 'start', 'end', 'dayCount', 'currency', 'tags', 'reminderDays', 'settings', 'perms', 'cover'];

/** Trip meta fit for a new trip: no share settings, archive flag or file cover; each optional field kept only if valid. */
export function cleanMeta(value) {
  if (!plainObject(value)) return null;
  const base = { title: cleanLine(value.title) || null, currency: value.currency };
  try { validateEntity('trip', 'meta', base); } catch { return null; }
  const meta = { ...base };
  for (const field of META_FIELDS) {
    if (field in base || !Object.hasOwn(value, field) || value[field] === undefined) continue;
    if (field === 'cover' && typeof value.cover === 'string') continue;
    const candidate = { ...meta, [field]: value[field] };
    try { validateEntity('trip', 'meta', candidate); meta[field] = structuredClone(value[field]); } catch { /* drop the field */ }
  }
  return meta;
}
