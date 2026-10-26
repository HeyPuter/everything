// The worker's transfer export (`trips-transfer`, data-model §6) and the import plan built from it: which entities
// still need writing to the new worker, in calls that fit the request limits.
import { isHlc } from '../../shared/hlc.js';
import { isId, isUuid } from '../../shared/ids.js';
import { LIMITS } from '../../shared/limits.js';
import { fileLinks } from '../../shared/file-links.js';
import { plainObject } from '../../shared/schema/dsl.js';
import { SERVER_FIELDS, schemas, validateEntity } from '../../shared/schema/index.js';

export const TRANSFER_FORMAT = 'trips-transfer';
const SKIP = new Set(['meta', 'member', 'file']);
const AUTHOR_TYPES = new Set(['note', 'link', 'poll', 'msg']);
// Leaves room in the 1 MB body for the envelope, authors and poll markers.
const PART_BYTES = 700_000;
const PART_ITEMS = LIMITS.commitWrites - 10;
const encoder = new TextEncoder();
const size = (value) => encoder.encode(JSON.stringify(value)).length;

export class TransferError extends Error {
  constructor(code, details = {}) { super(code); this.name = 'TransferError'; this.code = code; Object.assign(this, details); }
}

export const keyOf = (t, id) => `${t}:${id}`;

/**
 * Checks an export against the space and the shared schema. Returns `{rev, meta, ents, files, tombstones, members,
 * authors, pollvoted, invalid}`: `ents` are importable entities (not meta, members or files), `files` the live file
 * entities, and `invalid` counts entities the receiving worker would refuse.
 */
export function readTransferExport(raw, { space, kind = 'trip' } = {}) {
  if (!plainObject(raw) || raw.format !== TRANSFER_FORMAT || raw.version !== 1 || raw.space !== space || raw.kind !== kind
    || !Number.isSafeInteger(raw.rev) || !Array.isArray(raw.ents)) throw new TransferError('invalid_export');
  const types = schemas[kind];
  const ents = [];
  const files = [];
  let meta = null;
  let invalid = 0;
  for (const value of raw.ents) {
    if (!plainObject(value) || typeof value.t !== 'string' || !Object.hasOwn(types, value.t)) { invalid += 1; continue; }
    const { t, ...entity } = value;
    if (t === 'member') continue;
    try { validateEntity(kind, t, entity, { server: true }); } catch { invalid += 1; continue; }
    if (t === 'meta') meta = entity;
    else if (t === 'file') files.push(entity);
    else ents.push({ t, ...entity });
  }
  if (!meta) throw new TransferError('invalid_export');
  const tombstones = (Array.isArray(raw.tombstones) ? raw.tombstones : [])
    .filter((item) => plainObject(item) && typeof item.t === 'string' && !SKIP.has(item.t) && isId(item.id) && isHlc(item.v))
    .map((item) => ({ t: item.t, id: item.id, v: item.v }));
  const members = (Array.isArray(raw.members) ? raw.members : [])
    .filter((item) => plainObject(item) && isUuid(item.uuid) && ['owner', 'editor', 'viewer'].includes(item.role))
    .map((item) => ({ uuid: item.uuid, role: item.role, username: typeof item.username === 'string' ? item.username.slice(0, 64) : '' }));
  const authors = {};
  for (const [t, map] of Object.entries(plainObject(raw.authors) ? raw.authors : {})) {
    if (!AUTHOR_TYPES.has(t) || !plainObject(map)) continue;
    for (const [id, uuid] of Object.entries(map)) if (isId(id) && isUuid(uuid)) (authors[t] ??= {})[id] = uuid;
  }
  const pollvoted = (Array.isArray(raw.pollvoted) ? raw.pollvoted : []).filter(isId);
  return { rev: raw.rev, meta, ents, files, tombstones, members, authors, pollvoted, invalid };
}

/** Meta for creating the copy: no stamps, share settings or transfer state. */
export function copyMeta(meta) {
  const out = {};
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (!SERVER_FIELDS.includes(key) && !['t', 'share', 'transfer', 'movedTo'].includes(key)) out[key] = structuredClone(value);
  }
  return out;
}

/**
 * Import calls still needed, given `imported` (`{<t:id>: v}` already written by earlier calls): upserts for entities
 * whose version differs, deletes for entities written before that are gone now. Each part is
 * `{ents, del, authors?, pollvoted?, keys: {<t:id>: v|null}}`; `keys` is what to record once the part is acknowledged.
 */
export function importParts(data, imported = {}) {
  const live = new Map(data.ents.map((entity) => [keyOf(entity.t, entity.id), entity]));
  const tombs = new Map(data.tombstones.map((item) => [keyOf(item.t, item.id), item]));
  const voted = new Set(data.pollvoted);
  const parts = [];
  let part = null;
  let bytes = 0;
  const open = () => { part = { ents: [], del: [], keys: {} }; bytes = 0; parts.push(part); };
  const add = (list, item, key, value, extra = 0) => {
    const weight = size(item) + extra;
    if (!part || part.ents.length + part.del.length >= PART_ITEMS || (bytes + weight > PART_BYTES && (part.ents.length || part.del.length))) open();
    part[list].push(item);
    part.keys[key] = value;
    bytes += weight;
  };
  for (const [key, entity] of live) {
    if (imported[key] === entity.v) continue;
    const author = data.authors[entity.t]?.[entity.id];
    add('ents', entity, key, entity.v, author ? 80 : 0);
    if (author) ((part.authors ??= {})[entity.t] ??= {})[entity.id] = author;
    if (entity.t === 'poll' && voted.has(entity.id)) (part.pollvoted ??= []).push(entity.id);
  }
  for (const [key, v] of Object.entries(imported)) {
    if (live.has(key) || v === null) continue;
    const [t, id] = key.split(':');
    add('del', { t, id, v: tombs.get(key)?.v ?? v }, key, null);
  }
  return parts;
}

/**
 * File fields the copy takes from the source once the bytes are registered: `[{id, links?, star?, trashed?, desc?}]`
 * in parts. Both link forms go as one `links` list, which every worker build accepts.
 */
export function fileParts(files, copied) {
  const items = files.filter((file) => copied[file.id] === 'copied').map((file) => {
    const item = { id: file.id };
    const links = fileLinks(file);
    if (links.length) item.links = links;
    for (const field of ['star', 'trashed', 'desc']) if (file[field] !== undefined) item[field] = structuredClone(file[field]);
    return item;
  });
  const parts = [];
  for (let i = 0; i < items.length; i += 100) parts.push(items.slice(i, i + 100));
  return parts;
}

/** Seats for the members chosen to rejoin (all but the new owner when `chosen` is null); the old owner rejoins as an editor. */
export function seatsFor(members, newOwner, chosen = null) {
  const pick = chosen ? new Set(chosen) : null;
  return members.filter((member) => member.uuid !== newOwner && (!pick || pick.has(member.uuid)))
    .map((member) => ({ uuid: member.uuid, role: member.role === 'viewer' ? 'viewer' : 'editor', username: member.username }));
}
