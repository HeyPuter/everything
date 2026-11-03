import { can } from '../../src/shared/perms.js';
import { fail } from '../http.js';
import { K, spaceId } from '../keys.js';

// The space doc (kind, folders) changes only on delete, which also marks every member removed.
export const SPACE_TTL = 60_000;
export const MEMBER_TTL = 1000;
export const META_TTL = 5000;
export const REV_TTL = 1500;
export const RANK = Object.freeze({ viewer: 0, editor: 1, owner: 2 });
const DENIALS = 30;

function entry(w, id) {
  let s = w.spaces.get(id);
  if (!s) {
    s = { id, doc: null, docAt: -Infinity, meta: null, metaAt: -Infinity, rev: null, revAt: -Infinity, members: new Map() };
    w.spaces.set(id, s);
  }
  return s;
}

/** A member record is active when it has a role and no removal at or after its join. */
export const active = (record) => Boolean(record && Object.hasOwn(RANK, record.role) && !(record.removed >= record.joined));

/** Keys a caller should add to its own batched get so the space state is fresh afterwards. */
export function staleKeys(w, id, { uuid, meta = false, rev = false } = {}) {
  const s = entry(w, id);
  const time = w.now();
  const keys = [];
  if (!s.doc || time - s.docAt >= SPACE_TTL) keys.push(K.acl(id));
  if (uuid && !(time - (s.members.get(uuid)?.at ?? -Infinity) < MEMBER_TTL)) keys.push(K.member(id, uuid));
  if (meta && time - s.metaAt >= META_TTL) keys.push(K.entity(id, 'meta', 'meta'));
  if (rev && time - s.revAt >= REV_TTL) keys.push(K.rev(id));
  return keys;
}

/** Feeds values from any batched get back into the isolate cache. */
export function absorb(w, id, key, value) {
  const s = entry(w, id);
  const time = w.now();
  const memberPrefix = `sp:${id}:m:`;
  if (key === K.acl(id)) { s.doc = value ?? null; s.docAt = time; }
  else if (key.startsWith(memberPrefix)) {
    if (s.members.size > 200) s.members.clear();
    s.members.set(key.slice(memberPrefix.length), { value: value ?? null, at: time });
  } else if (key === K.entity(id, 'meta', 'meta')) { s.meta = value && !value.deleted ? value : null; s.metaAt = time; }
  else if (key === K.rev(id)) { s.rev = Number.isSafeInteger(value) ? Math.max(value, s.rev ?? 0) : (s.rev ?? 0); s.revAt = time; }
}

export function setMember(w, id, uuid, value) { absorb(w, id, K.member(id, uuid), value); }
export function forget(w, id) { w.spaces.delete(id); }

export function noteRev(w, id, rev) {
  const s = entry(w, id);
  if (rev > (s.rev ?? 0)) s.rev = rev;
  s.revAt = w.now();
}

const unlisted = async (w, caller) => {
  if (caller && caller === (await w.owner()).uuid) return 'reindex';
  return fail('space_not_found', 404);
};

/**
 * Refuses ids missing from `idx` without reading the space: 'ok', 'refresh' (a stale cached `idx` lists
 * the id; refresh it inside the caller's batched get) or 'reindex'. The worker owner always passes, so
 * `loadSpace` can re-index a live space whose `idx` entry a cross-region last-writer-wins write dropped.
 */
export async function hostedGate(w, id, caller) {
  const cached = w.hostedCached();
  if (cached && Object.hasOwn(cached.value, id)) return cached.fresh ? 'ok' : 'refresh';
  if (Object.hasOwn(await w.hosted([id]), id)) return 'ok';
  return unlisted(w, caller);
}

/** Loads the space doc, plus the caller's member record, meta or rev when asked, through the isolate caches. */
export async function loadSpace(w, id, options = {}) {
  spaceId(id);
  const caller = options.caller ?? options.uuid;
  let gate = await hostedGate(w, id, caller);
  const keys = options.fresh
    ? [K.acl(id), ...(options.uuid ? [K.member(id, options.uuid)] : []), ...(options.meta ? [K.entity(id, 'meta', 'meta')] : []), ...(options.rev ? [K.rev(id)] : [])]
    : staleKeys(w, id, options);
  if (gate === 'refresh') keys.push(K.idx);
  if (keys.length) {
    const values = await w.kv.getMany(keys);
    keys.forEach((key, index) => (key === K.idx ? w.hostedSet(values[index]) : absorb(w, id, key, values[index])));
  }
  if (gate === 'refresh') gate = Object.hasOwn(w.hostedCached().value, id) ? 'ok' : await unlisted(w, caller);
  const s = entry(w, id);
  if (!s.doc || s.doc.deleted) { forget(w, id); fail('space_not_found', 404); }
  if (gate === 'reindex') {
    const item = { k: s.doc.k, created: s.doc.created };
    await w.kv.update(K.idx, { [id]: item });
    w.hostedAdd(id, item);
  }
  return s;
}

/** Loads a space for an authenticated caller and requires membership. Repeated denials stop costing reads. */
export async function loadMember(w, ident, id, options = {}) {
  const deny = `deny:${ident.uuid}:${id}`;
  const denyAll = `deny:${ident.uuid}`;
  if (!w.limiter.check(deny, DENIALS, 60_000) || !w.limiter.check(denyAll, DENIALS * 10, 60_000)) fail('rate_limited', 429, { retryAfter: 60 });
  try {
    const s = await loadSpace(w, id, { ...options, uuid: ident.uuid });
    return { s, role: requireMember(s, ident.uuid) };
  } catch (error) {
    if (error?.status === 403 || error?.status === 404) { w.limiter.take(deny, DENIALS, 60_000); w.limiter.take(denyAll, DENIALS * 10, 60_000); }
    throw error;
  }
}

export const recordOf = (s, uuid) => s.members.get(uuid)?.value ?? null;
export const roleOf = (s, uuid) => (active(recordOf(s, uuid)) ? recordOf(s, uuid).role : null);

export function requireMember(s, uuid) {
  const role = roleOf(s, uuid);
  if (!role) fail('not_member', 403);
  return role;
}

/** Member records for other users (role changes, removals, presence). */
export async function loadRecords(w, id, uuids, { fresh = false } = {}) {
  const s = entry(w, id);
  const time = w.now();
  const keys = [...new Set(uuids)].filter((uuid) => fresh || !(time - (s.members.get(uuid)?.at ?? -Infinity) < MEMBER_TTL)).map((uuid) => K.member(id, uuid));
  if (keys.length) (await w.kv.getMany(keys)).forEach((value, i) => absorb(w, id, keys[i], value));
  return s;
}

export const permsOf = (s) => (s.meta?.perms && typeof s.meta.perms === 'object' ? s.meta.perms : {});
export const kindOf = (s) => s.doc.k;

/** Runs the registry's write guards (an ownership transfer freezes a space) before a write of `action`. */
export function guardWrite(w, s, action) {
  for (const guard of w.ops.guards ?? []) guard(s, action);
}

export function requireCan(s, role, action) {
  if (!can(role, action, permsOf(s))) fail('forbidden', 403);
}

export function titleOf(kind, meta) {
  const value = kind === 'collection' ? meta?.name : meta?.title;
  return typeof value === 'string' && value.trim() ? value : null;
}
