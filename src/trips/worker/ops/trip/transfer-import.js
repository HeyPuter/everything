// Ownership transfer, receiving side: the new owner imports a frozen space under the same space and entity ids
// (`transfer.import`, owner only), and former members rejoin through seats (`transfer.join`).
import { compareHlc, isHlc } from '../../../src/shared/hlc.js';
import { isId, isUuid } from '../../../src/shared/ids.js';
import { LIMITS, TIMING } from '../../../src/shared/limits.js';
import { WORKER_PATTERN } from '../../../src/shared/protocol.js';
import { plainObject } from '../../../src/shared/schema/dsl.js';
import { SERVER_FIELDS, schemas, validateEntity } from '../../../src/shared/schema/index.js';
import { check, fail } from '../../http.js';
import { K, own, spaceId } from '../../keys.js';
import { AUTHOR_TYPES, COLLAB_CAP, workerChange } from '../../engine/commit.js';
import { throttle } from '../../engine/limits.js';
import { persist } from '../../engine/log.js';
import { colorFor, ensureAccess, filesInfo } from '../../engine/members.js';
import { spaceCreate } from '../../engine/spaces.js';
import { absorb, forget, guardWrite, hostedGate, kindOf, loadSpace, roleOf, setMember } from '../../engine/space.js';
import { GRACE } from './transfer.js';

export const xinKey = (sid) => K.xin(sid);
export const seatKey = (sid, uuid) => K.seat(sid, uuid);
const SKIP = new Set(['meta', 'member', 'file']);
const FILE_FIELDS = ['links', 'linked', 'star', 'trashed', 'desc'];
const CAPS = Object.freeze({ e: LIMITS.entities, day: LIMITS.days, place: LIMITS.places, collab: COLLAB_CAP });
const counted = (t) => (t === 'msg' || SKIP.has(t) ? [] : t === 'day' || t === 'place' ? ['e', t] : ['note', 'link', 'poll'].includes(t) ? ['e', 'collab'] : ['e']);
const sameSource = (a, b) => a?.w === b?.w && a?.s === b?.s;
const canonical = (value) => JSON.stringify(value, (_, item) => (plainObject(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1))) : item));
const withoutRev = ({ rev: _rev, ...rest }) => canonical(rest);

/** Meta fit for the new space: no stamps, share settings or transfer state. */
function freshMeta(value) {
  check(plainObject(value), 'invalid_meta');
  const meta = {};
  for (const [key, item] of Object.entries(value)) {
    if (!SERVER_FIELDS.includes(key) && !['t', 'share', 'transfer', 'movedTo'].includes(key)) meta[key] = item;
  }
  return meta;
}

async function ensureSpace(w, ident, sid, from, create) {
  let [xin, doc] = await w.kv.getMany([xinKey(sid), K.acl(sid)]);
  if (create === undefined) {
    if (!xin || !sameSource(xin.from, from) || !doc || doc.deleted) fail('import_conflict', 409);
    return;
  }
  check(plainObject(create) && create.kind === 'trip', 'invalid_kind');
  const meta = freshMeta(create.meta);
  validateEntity('trip', 'meta', meta);
  if (xin && !sameSource(xin.from, from)) fail('import_conflict', 409);
  if (!xin && doc && !doc.deleted) fail('import_conflict', 409);
  if (doc?.deleted) {
    // A copy deleted earlier (a cancelled move) can be made again once its purge has finished.
    if (Object.hasOwn((await w.kv.get(K.purge)) ?? {}, sid)) fail('space_purging', 409, { retryAfter: 60 });
    await w.kv.del(K.acl(sid));
    forget(w, sid);
    doc = null;
    xin = null;
  }
  if (!xin) await w.kv.set(xinKey(sid), { from: { w: from.w, s: from.s }, by: ident.uuid, at: w.now() });
  if (!doc) await spaceCreate(w, ident, { kind: 'trip', meta, space: sid });
}

function entityItems(kind, list) {
  return list.map((raw) => {
    check(plainObject(raw) && typeof raw.t === 'string' && Object.hasOwn(schemas[kind], raw.t) && !SKIP.has(raw.t), 'invalid_entity');
    const { t, ...entity } = raw;
    validateEntity(kind, t, entity, { server: true });
    return { t, id: entity.id, entity };
  });
}

function deleteItems(list) {
  return list.map((raw) => {
    check(plainObject(raw) && typeof raw.t === 'string' && !SKIP.has(raw.t) && isId(raw.id) && isHlc(raw.v), 'invalid_delete');
    return { t: raw.t, id: raw.id, v: raw.v };
  });
}

function fileItems(list) {
  return list.map((raw) => {
    check(plainObject(raw) && isId(raw.id) && Object.keys(raw).every((key) => key === 'id' || FILE_FIELDS.includes(key)), 'invalid_file');
    return raw;
  });
}

function extraItems(sid, authors, pollvoted) {
  const out = [];
  if (authors !== undefined) {
    check(plainObject(authors), 'invalid_authors');
    for (const [t, map] of Object.entries(authors)) {
      check(AUTHOR_TYPES.has(t) && plainObject(map), 'invalid_authors');
      for (const [eid, uuid] of Object.entries(map)) {
        check(isId(eid) && isUuid(uuid), 'invalid_authors');
        out.push({ key: K.author(sid, t, eid), value: uuid });
      }
    }
  }
  if (pollvoted !== undefined) {
    check(Array.isArray(pollvoted) && pollvoted.every(isId), 'invalid_pollvoted');
    for (const eid of pollvoted) out.push({ key: K.pollvoted(sid, eid), value: true });
  }
  check(out.length <= 2000, 'too_many_writes', 413);
  return out;
}

async function writeSeats(w, sid, owner, seats) {
  check(Array.isArray(seats) && seats.length <= LIMITS.members, 'invalid_seats');
  const list = seats.map((seat) => {
    check(plainObject(seat) && isUuid(seat.uuid) && (seat.role === 'editor' || seat.role === 'viewer')
      && (seat.username === undefined || (typeof seat.username === 'string' && seat.username.length <= 64)), 'invalid_seats');
    return seat;
  }).filter((seat) => seat.uuid !== owner);
  const current = await w.kv.getMany(list.map((seat) => seatKey(sid, seat.uuid)));
  const exp = w.now() + GRACE;
  // A claimed seat keeps its claim, so a member removed after rejoining cannot use it again.
  const items = list.filter((_, i) => !current[i]?.claimed)
    .map((seat) => ({ key: seatKey(sid, seat.uuid), value: { role: seat.role, username: seat.username ?? '', exp }, expireAt: exp }));
  await w.kv.setMany(items);
  return items.length;
}

/**
 * `{from, part?, create?, ents?, del?, files?, authors?, pollvoted?, seats?}` → `{rev, space, skipped}` (data-model §6).
 * Entities keep their ids and versions; a newer version already here wins, so retries and repeated passes converge.
 */
async function importSpace(w, ident, input) {
  const owner = await w.owner();
  if (ident.uuid !== owner.uuid) fail('forbidden', 403);
  const sid = spaceId(input.space);
  const from = input.from;
  check(plainObject(from) && typeof from.w === 'string' && WORKER_PATTERN.test(from.w) && from.w !== w.workerName && from.s === sid, 'invalid_source');
  check(input.part === undefined || isId(input.part), 'invalid_part');
  throttle(w, `ximport:${sid}`, 240, 60_000);
  if (input.part !== undefined) {
    const done = await w.kv.get(K.opdone(sid, input.part));
    if (Number.isSafeInteger(done) && done > 0) return { rev: done, space: sid, skipped: [] };
  }
  await ensureSpace(w, ident, sid, from, input.create);
  const s = await loadSpace(w, sid, { meta: true, uuid: ident.uuid, rev: true });
  const kind = kindOf(s);
  const ents = entityItems(kind, input.ents ?? []);
  const dels = deleteItems(input.del ?? []);
  const files = fileItems(input.files ?? []);
  check(ents.length + dels.length + files.length <= LIMITS.commitWrites, 'too_many_writes', 413);
  const extra = extraItems(sid, input.authors, input.pollvoted);
  const keys = [...new Set([...ents, ...dels, ...files.map((file) => ({ t: 'file', id: file.id }))].map(({ t, id }) => K.entity(sid, t, id))), K.count(sid)];
  const values = await w.kv.getMany(keys);
  const got = new Map(keys.map((key, i) => [key, values[i]]));
  const now = w.now();
  const writes = [];
  const skipped = [];
  const deltas = {};
  const bump = (t, sign) => { for (const name of counted(t)) deltas[name] = (deltas[name] ?? 0) + sign; };
  const newer = (current, v) => current && isHlc(current.v) && compareHlc(current.v, v) > 0;
  for (const { t, id, entity } of ents) {
    const key = K.entity(sid, t, id);
    const current = got.get(key);
    if (newer(current, entity.v)) { skipped.push({ t, id, reason: 'newer' }); continue; }
    if (current && !current.deleted && withoutRev(current) === withoutRev(entity)) continue;
    const live = Boolean(current && !current.deleted);
    writes.push({ t, id, key, mode: live ? 'full' : 'put', created: !live, entity: { ...structuredClone(entity), rev: 0 }, before: live ? current : null, fields: [] });
    if (!live) bump(t, 1);
  }
  for (const { t, id, v } of dels) {
    const key = K.entity(sid, t, id);
    const current = got.get(key);
    if (!current || current.deleted) continue;
    if (newer(current, v)) { skipped.push({ t, id, reason: 'newer' }); continue; }
    writes.push({ t, id, key, mode: 'del', entity: { id, t, deleted: true, rev: 0, v }, before: current, fields: [] });
    bump(t, -1);
  }
  for (const patch of files) {
    const key = K.entity(sid, 'file', patch.id);
    const current = got.get(key);
    if (!current || current.deleted) { skipped.push({ t: 'file', id: patch.id, reason: 'missing' }); continue; }
    const next = structuredClone(current);
    for (const field of FILE_FIELDS) { if (Object.hasOwn(patch, field)) next[field] = structuredClone(patch[field]); else delete next[field]; }
    if (FILE_FIELDS.every((field) => JSON.stringify(own(next, field)) === JSON.stringify(own(current, field)))) continue;
    Object.assign(next, { v: w.clock.tick(current.v), upd: now, by: ident.uuid });
    validateEntity(kind, 'file', next, { server: true });
    writes.push({ t: 'file', id: patch.id, key, mode: 'full', entity: next, before: current, fields: FILE_FIELDS.filter((field) => Object.hasOwn(patch, field)) });
  }
  const count = got.get(K.count(sid));
  for (const [name, delta] of Object.entries(deltas)) {
    if (delta > 0 && (Number(own(count, name)) || 0) + delta > CAPS[name]) fail('space_full', 409, { limit: name });
  }
  let rev = s.rev ?? 0;
  if (writes.length) rev = (await persist(w, sid, ident.uuid, { writes, extra, deltas })).rev;
  else if (extra.length) await w.kv.setMany(extra);
  if (input.seats !== undefined) await writeSeats(w, sid, owner.uuid, input.seats);
  if (input.part !== undefined) await w.kv.set(K.opdone(sid, input.part), Math.max(rev, 1), { expireAt: now + TIMING.idempotency });
  return { rev, space: sid, skipped };
}

/** `{}` → like `join`. A member of a moved trip rejoins with the role their seat holds. */
async function joinSeat(w, ident, input) {
  const sid = spaceId(input.space);
  throttle(w, `xjoin:${ident.uuid}`, 20, 60_000);
  await hostedGate(w, sid, ident.uuid);
  const memberKey = K.entity(sid, 'member', ident.uuid);
  const keys = [K.acl(sid), K.member(sid, ident.uuid), K.entity(sid, 'meta', 'meta'), K.rev(sid), K.count(sid), K.filesMode(sid),
    K.handles(sid, ident.uuid), memberKey, seatKey(sid, ident.uuid)];
  const values = await w.kv.getMany(keys);
  const got = new Map(keys.map((key, i) => [key, values[i]]));
  for (const key of keys.slice(0, 4)) absorb(w, sid, key, got.get(key));
  const s = await loadSpace(w, sid, { meta: true, caller: ident.uuid });
  let role = roleOf(s, ident.uuid);
  let rev = s.rev ?? 0;
  if (!role) {
    guardWrite(w, s, 'join');
    const seat = got.get(seatKey(sid, ident.uuid));
    const reason = !seat ? 'invalid' : seat.claimed ? 'used' : !(seat.exp > w.now()) ? 'expired' : null;
    if (reason) fail('seat_invalid', 404, { reason });
    check((Number(own(got.get(K.count(sid)), 'members')) || 0) < LIMITS.members, 'space_full', 409);
    // Claimed before the membership is written, so a seat is used at most once.
    await w.kv.update(seatKey(sid, ident.uuid), { claimed: w.now() });
    role = seat.role;
    const entry = { role, username: ident.username, joined: w.now(), via: 'transfer' };
    await w.kv.set(K.member(sid, ident.uuid), entry);
    setMember(w, sid, ident.uuid, entry);
    const current = got.get(memberKey);
    const fields = { name: ident.username || seat.username || 'member', role, color: colorFor(ident.uuid) };
    const item = current && !current.deleted ? { t: 'member', id: ident.uuid, set: fields } : { t: 'member', id: ident.uuid, put: fields };
    rev = (await workerChange(w, sid, ident.uuid, [item], { kind: kindOf(s), got, revive: true, deltas: { members: 1 } })).rev;
  }
  const handles = got.get(K.handles(sid, ident.uuid));
  const { access, mode } = role === 'owner'
    ? { access: handles ?? {}, mode: got.get(K.filesMode(sid)) }
    : await ensureAccess(w, sid, s, ident, role, handles, got.get(K.filesMode(sid)));
  return {
    space: sid, kind: kindOf(s), role, rev,
    ...(access.read && access.write ? { handles: { read: access.read, write: access.write } } : {}),
    files: filesInfo(s.doc, mode, access, role === 'owner'),
  };
}

export const transferImportOps = Object.freeze({
  'transfer.import': importSpace,
  'transfer.join': joinSeat,
});
