// Ownership transfer, source side (architecture §16): the owner offers the trip to a member, who accepts from their
// own app. Accepting freezes the space; the new owner exports it, imports it into their worker
// (`transfer-import.js`) and completes the move, which leaves `meta.movedTo` behind as a read-only stub.
import { isUuid } from '../../../src/shared/ids.js';
import { can } from '../../../src/shared/perms.js';
import { WORKER_PATTERN } from '../../../src/shared/protocol.js';
import { plainObject } from '../../../src/shared/schema/dsl.js';
import { bytesResponse, check, fail } from '../../http.js';
import { K, spaceId, uuidOf } from '../../keys.js';
import { AUTHOR_TYPES, workerChange } from '../../engine/commit.js';
import { DAY, throttle } from '../../engine/limits.js';
import { recordsUnder } from '../../engine/scan.js';
import { collect, gzip } from '../../engine/snapshot.js';
import { META_TTL, active, forget, kindOf, loadMember, loadRecords, permsOf, recordOf, roleOf } from '../../engine/space.js';

export const OFFER_TTL = 14 * DAY;
/** How long a moved space stays as a stub before its old owner's app deletes it. */
export const GRACE = 30 * DAY;
// Other isolates may hold the old meta for META_TTL, so the export waits that long after the freeze.
export const SETTLE = META_TTL + 1000;
export const xferKey = (sid) => `sp:${sid}:xfer`;

/** Write guard: a space being moved, or moved, takes no more writes. */
export function transferGuard(s) {
  if (s.meta?.movedTo) fail('space_moved', 409);
  if (s.meta?.transfer?.state === 'moving') fail('space_moving', 409);
}

const view = (record) => ({
  to: record.to, ...(record.toName ? { name: record.toName } : {}), by: record.by, at: record.at, exp: record.exp, state: record.state,
  ...(record.worker ? { worker: record.worker } : {}),
});

async function setMeta(w, sid, s, actor, { set, unset }) {
  const op = { t: 'meta', id: 'meta', ...(set ? { set } : {}), ...(unset?.length ? { unset } : {}) };
  if (!op.set && !op.unset) return null;
  const result = await workerChange(w, sid, actor, [op], { kind: kindOf(s) });
  forget(w, sid);
  return result?.rev ?? null;
}

/** `{to}` → `{transfer}`. Offers the trip to an editor or viewer; offering again replaces an earlier offer. */
async function offer(w, ident, input) {
  const sid = spaceId(input.space);
  const to = uuidOf(input.to);
  const { s, role } = await loadMember(w, ident, sid, { meta: true });
  if (!can(role, 'transfer', permsOf(s))) fail('forbidden', 403);
  check(kindOf(s) === 'trip', 'invalid_kind');
  check(to !== ident.uuid, 'invalid_target');
  throttle(w, `xfer:${sid}:${ident.uuid}`, 20, 60_000);
  const current = await w.kv.get(xferKey(sid));
  if (current?.state === 'moved' || s.meta?.movedTo) fail('space_moved', 409);
  if (current?.state === 'moving') fail('transfer_in_progress', 409);
  await loadRecords(w, sid, [to], { fresh: true });
  const target = roleOf(s, to);
  if (!target || target === 'owner') fail('not_member', 404);
  const now = w.now();
  if (current?.state === 'offered' && current.to === to && current.exp > now && s.meta?.transfer?.to === to) return { transfer: view(current) };
  const record = { to, toName: recordOf(s, to)?.username || '', by: ident.uuid, at: now, exp: now + OFFER_TTL, state: 'offered' };
  await w.kv.set(xferKey(sid), record);
  const rev = await setMeta(w, sid, s, ident.uuid, { set: { transfer: view(record) } });
  return { transfer: view(record), rev };
}

/** `{}`: the owner withdraws, or the offered member declines, an offer or a move that has not completed. */
async function cancel(w, ident, input) {
  const sid = spaceId(input.space);
  const { s, role } = await loadMember(w, ident, sid, { meta: true });
  throttle(w, `xfer:${sid}:${ident.uuid}`, 20, 60_000);
  const current = await w.kv.get(xferKey(sid));
  if (current?.state === 'moved' || s.meta?.movedTo) fail('space_moved', 409);
  const owner = can(role, 'transfer', permsOf(s));
  if (!owner && !(current && current.to === ident.uuid)) fail('forbidden', 403);
  if (current) await w.kv.del(xferKey(sid));
  const rev = current || s.meta?.transfer ? await setMeta(w, sid, s, ident.uuid, { unset: ['transfer'] }) : null;
  return { cancelled: Boolean(current), rev };
}

/** `{worker}` → `{transfer, settleAt}`. The offered member accepts into their own worker; the space freezes. */
async function accept(w, ident, input) {
  const sid = spaceId(input.space);
  check(typeof input.worker === 'string' && WORKER_PATTERN.test(input.worker) && input.worker !== w.workerName, 'invalid_worker');
  const { s } = await loadMember(w, ident, sid, { meta: true });
  throttle(w, `xfer:${sid}:${ident.uuid}`, 20, 60_000);
  const current = await w.kv.get(xferKey(sid));
  if (current?.state === 'moved' || s.meta?.movedTo) fail('space_moved', 409);
  if (!current || current.to !== ident.uuid) fail('no_offer', 404);
  const now = w.now();
  if (current.state === 'offered' && !(current.exp > now)) fail('offer_expired', 409);
  if (current.state === 'moving' && current.worker === input.worker && s.meta?.transfer?.state === 'moving') {
    return { transfer: view(current), settleAt: current.frozenAt + SETTLE };
  }
  const next = { ...current, state: 'moving', worker: input.worker };
  // The meta write is the freeze; the settle time counts from after it.
  await setMeta(w, sid, s, ident.uuid, { set: { transfer: view(next) } });
  next.frozenAt = current.state === 'moving' && Number.isSafeInteger(current.frozenAt) ? current.frozenAt : w.now();
  await w.kv.set(xferKey(sid), next);
  return { transfer: view(next), settleAt: next.frozenAt + SETTLE };
}

async function movingFor(w, ident, sid, { moved = false } = {}) {
  const current = await w.kv.get(xferKey(sid));
  const ok = current && current.to === ident.uuid && (current.state === 'moving' || (moved && current.state === 'moved'));
  if (!ok) fail(current?.state === 'moved' ? 'space_moved' : 'transfer_cancelled', 409);
  return current;
}

/** Streams the frozen space for the new owner: every entity and message, members, authorship and poll markers. */
async function exportSpace(w, ident, input) {
  const sid = spaceId(input.space);
  const { s } = await loadMember(w, ident, sid, { meta: true });
  const current = await movingFor(w, ident, sid, { moved: true });
  const wait = (Number(current.frozenAt) || 0) + SETTLE - w.now();
  if (current.state === 'moving' && wait > 0) fail('transfer_settling', 409, { retryAfter: Math.ceil(wait / 1000) });
  throttle(w, `xexport:${sid}`, 6, 60_000);
  const { snapshot, complete } = await collect(w, sid, kindOf(s), { everyMessage: true });
  if (!complete) fail('space_too_large', 413);
  const members = (await recordsUnder(w, sid, 'm')).filter(({ value }) => active(value))
    .map(({ uuid, value }) => ({ uuid, role: value.role, username: value.username ?? '' }));
  const authored = snapshot.ents.filter((entity) => AUTHOR_TYPES.has(entity.t));
  const creators = await w.kv.getMany(authored.map((entity) => K.author(sid, entity.t, entity.id)));
  const authors = {};
  authored.forEach((entity, i) => { if (isUuid(creators[i])) (authors[entity.t] ??= {})[entity.id] = creators[i]; });
  const polls = snapshot.ents.filter((entity) => entity.t === 'poll');
  const voted = await w.kv.getMany(polls.map((entity) => K.pollvoted(sid, entity.id)));
  const pollvoted = polls.filter((_, i) => voted[i]).map((entity) => entity.id);
  const bytes = await gzip(JSON.stringify({ format: 'trips-transfer', version: 1, space: sid, ...snapshot, members, authors, pollvoted }));
  return bytesResponse(bytes, { type: 'application/gzip' });
}

/** `{to: {w, s}, rev}` → `{movedTo}`. Refuses with `transfer_stale` when anything was written after that export. */
async function complete(w, ident, input) {
  const sid = spaceId(input.space);
  check(plainObject(input.to) && typeof input.to.w === 'string' && WORKER_PATTERN.test(input.to.w) && input.to.s === sid, 'invalid_target');
  check(Number.isSafeInteger(input.rev) && input.rev >= 0, 'invalid_rev');
  const { s } = await loadMember(w, ident, sid, { meta: true });
  throttle(w, `xfer:${sid}:${ident.uuid}`, 20, 60_000);
  const current = await movingFor(w, ident, sid, { moved: true });
  if (current.state === 'moved') {
    if (current.movedTo?.w !== input.to.w) fail('space_moved', 409);
    return { movedTo: current.movedTo };
  }
  check(input.to.w === current.worker, 'invalid_target');
  const rev = (await w.kv.get(K.rev(sid))) ?? 0;
  if (rev > input.rev) fail('transfer_stale', 409, { rev });
  const movedTo = { w: input.to.w, s: sid, at: w.now(), ...(current.toName ? { name: current.toName } : {}) };
  await w.kv.set(xferKey(sid), { ...current, state: 'moved', movedTo });
  await setMeta(w, sid, s, ident.uuid, { set: { movedTo }, unset: ['transfer'] });
  return { movedTo };
}

export const transferOps = Object.freeze({
  'transfer.offer': offer,
  'transfer.cancel': cancel,
  'transfer.accept': accept,
  'transfer.export': exportSpace,
  'transfer.complete': complete,
});
