import { isUuid } from '../../src/shared/ids.js';
import { shareLabel } from '../../src/shared/share-label.js';
import { LIMITS } from '../../src/shared/limits.js';
import { can } from '../../src/shared/perms.js';
import { check, fail } from '../http.js';
import { HEX32, HEX64, K, P, own, randomHex, sha256Hex, spaceId, uuidOf } from '../keys.js';
import { workerChange } from './commit.js';
import { DAY, kvBudget, throttle } from './limits.js';
import { dropInbox, fsGone } from './inbox.js';
import { purgeRegion, recordsUnder } from './scan.js';
import { RANK, absorb, active, guardWrite, hostedGate, kindOf, loadMember, loadRecords, loadSpace, permsOf, recordOf, requireCan, roleOf, setMember, staleKeys, titleOf } from './space.js';

const INVITE_DEFAULT = 14 * DAY;
const INVITE_MAX = 90 * DAY;
const FAILED_JOINS = 8;
const FAIL_WINDOW = 600_000;
const joinFails = (sid, ident) => `joinfail:${sid}:${ident.uuid}`;
const HANDLES_RETRY = 10 * 60_000;
const USERNAME = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_INVITES = 200;
// Invite records outlive their expiry so a failed join can say why.
const KEEP = 30 * DAY;
const LABEL_CHARS = 80;
// Platform refusals that keep members on path C until the next retry: sharing off, no share slots left, or the owner
// has not given the app the `kvShare` consent.
const HANDLE_BACKOFF = new Set(['kv_handles_disabled', 'events_kv_handle_limit_reached', 'events_kv_handle_not_delegated']);

export function colorFor(uuid) {
  let hash = 0;
  for (const char of uuid) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return (hash % 8) + 1;
}

const ignore = (promise) => promise.catch(() => {});
const gone = (error) => error?.code === 'subject_does_not_exist' || error?.status === 404;

/** Files block of `open`/`join`. The owner always uses its own AppData directly. */
export function filesInfo(doc, mode, access, owner) {
  if (owner || (mode === 'direct' && access?.files)) {
    return { mode: 'direct', ...(doc?.folders?.files ? { uid: doc.folders.files } : {}), ...(access?.inbox ? { inbox: access.inbox } : {}) };
  }
  return { mode: 'proxied' };
}

/**
 * Drops `files/` shares held by anyone who is not an active member. File shares go by username, which the holder
 * can change; the share listing names holders as they are called now. False when the platform cannot list shares.
 */
export async function reconcileFileShares(w, sid) {
  if (typeof w.fs.getShares !== 'function') return false;
  let shares;
  try { shares = await w.fs.getShares(P.files(sid)); } catch (error) { if (fsGone(error)) return true; throw error; }
  const holders = [...new Set((Array.isArray(shares) ? shares : [])
    .filter((share) => typeof share?.holder === 'string' && share.holder && !share.inheritedFrom).map((share) => share.holder))];
  if (!holders.length) return true;
  // A renamed member drops out here too; their next `open {renew}` shares the folder under the new name.
  const records = await recordsUnder(w, sid, 'm');
  const allowed = new Set(records.filter(({ value }) => active(value) && typeof value.username === 'string').map(({ value }) => value.username.toLowerCase()));
  for (const holder of holders) if (!allowed.has(holder.toLowerCase())) await w.fs.unshare(P.files(sid), holder);
  return true;
}

/** Unshares a member's grants; returns the ones that could not be revoked yet. */
export async function revokeAccess(w, sid, uuid, username, record) {
  const left = {};
  const attempt = async (field, run) => { try { await run(); } catch (error) { if (!gone(error)) left[field] = record[field]; } };
  await Promise.all([
    record?.read ? attempt('read', () => w.kv.unshare(record.read)) : null,
    record?.write ? attempt('write', () => w.kv.unshare(record.write)) : null,
    record?.inbox ? attempt('inbox', () => dropInbox(w, sid, uuid, username)) : null,
  ]);
  if (record?.files) {
    // An unshare by a stale username revokes nothing and still succeeds, so the share listing decides.
    try {
      if (username) await w.fs.unshare(P.files(sid), username).catch((error) => { if (!fsGone(error)) throw error; });
      if (!(await reconcileFileShares(w, sid)) && !username) left.files = record.files;
    } catch { left.files = record.files; }
  }
  return left;
}

/** Keeps unrevoked grants on record so maintenance retries them. */
async function settleRevocation(w, sid, uuid, username, record) {
  const left = await revokeAccess(w, sid, uuid, username, record);
  if (Object.keys(left).length) await w.kv.set(K.handles(sid, uuid), { ...left, revoke: true, username });
  else await ignore(w.kv.del(K.handles(sid, uuid)));
}

/**
 * Mints missing handles and direct-file shares. Failures degrade to path C / proxied files and retry on the next open.
 * `renew` re-shares grants the member reports as unusable; a share that is still live keeps its id.
 */
export async function ensureAccess(w, sid, s, ident, role, record, mode, { renew = false } = {}) {
  const access = record?.revoke ? {} : { ...(record ?? {}) };
  let changed = false;
  let files = mode ?? null;
  if ((renew || !access.read || !access.write) && w.features.handlesOff <= w.now()) {
    try {
      const read = await w.kv.share({ prefix: K.shared(sid), recipient: { uid: ident.uuid }, access: 'read' });
      const write = await w.kv.share({ prefix: K.region(sid, ident.uuid), recipient: { uid: ident.uuid }, access: 'write' });
      if (read.handle !== access.read || write.handle !== access.write) {
        Object.assign(access, { read: read.handle, write: write.handle, minted: w.now() });
        changed = true;
      }
    } catch (error) {
      if (HANDLE_BACKOFF.has(error?.code)) w.features.handlesOff = w.now() + HANDLES_RETRY;
    }
  }
  // Folder re-shares need no record write (the record already lists them), only the membership re-check below.
  let reshared = false;
  if (renew && files === 'direct' && access.files) {
    reshared = true;
    await w.fs.share(P.files(sid), ident.username, 'read').catch(() => {});
    if (access.inbox && can(role, 'files.upload', permsOf(s))) await w.fs.share(P.inboxOf(sid, ident.uuid), ident.username, 'write').catch(() => {});
  }
  if (files !== 'proxied' && !access.files) {
    try {
      await w.fs.share(P.files(sid), ident.username, 'read');
      access.files = true;
      changed = true;
      if (files !== 'direct') { files = 'direct'; await w.kv.set(K.filesMode(sid), 'direct'); }
    } catch (error) {
      if (error?.code === 'verification_required') { files = 'proxied'; await ignore(w.kv.set(K.filesMode(sid), 'proxied')); }
    }
  }
  if (access.files && !access.inbox && !(access.inboxHold > w.now()) && can(role, 'files.upload', permsOf(s))) {
    try {
      const folder = await w.fs.mkdir(P.inboxOf(sid, ident.uuid), { createMissingParents: true });
      await w.fs.share(P.inboxOf(sid, ident.uuid), ident.username, 'write');
      access.inbox = folder.uid;
      changed = true;
    } catch { /* retried on the next open */ }
  }
  if (changed || reshared) {
    if (changed) await w.kv.set(K.handles(sid, ident.uuid), access);
    // Re-check after the record is written: a concurrent removal either sees these grants or is seen here.
    await loadRecords(w, sid, [ident.uuid], { fresh: true });
    if (!roleOf(s, ident.uuid)) {
      await settleRevocation(w, sid, ident.uuid, ident.username, access);
      fail('not_member', 403);
    }
  }
  return { access, mode: files };
}

async function upsertMember(w, sid, s, actor, uuid, fields) {
  const key = K.entity(sid, 'member', uuid);
  const current = await w.kv.get(key);
  const name = recordOf(s, uuid)?.username || 'member';
  const item = current && !current.deleted ? { t: 'member', id: uuid, set: fields } : { t: 'member', id: uuid, put: { name, color: colorFor(uuid), role: 'viewer', ...fields } };
  return workerChange(w, sid, actor, [item], { kind: kindOf(s), got: new Map([[key, current]]), revive: true });
}

/** `keep` leaves the invite record (expired or revoked) for failure reasons until its TTL. */
export async function cleanupInvite(w, sid, hash, record, { keep = false } = {}) {
  await Promise.all([
    keep ? null : ignore(w.kv.del(K.inv(sid, hash))),
    ignore(w.kv.del(K.invc(sid, hash))),
    ignore(w.kv.remove(K.invs(sid), [hash])),
    record?.handle ? ignore(w.kv.unshare(record.handle)) : null,
    record?.stub ? ignore(w.kv.del(K.stub(record.stub))) : null,
  ]);
}

const summary = ({ role, exp, max, by, created, named, label }) => ({ role, exp, max, by, created, ...(named ? { named } : {}), ...(label ? { label } : {}) });

/** Display-only name for a link invite ("For Maria"). */
function labelOf(value) {
  if (value === undefined) return undefined;
  check(typeof value === 'string', 'invalid_label');
  const text = value.trim();
  check(text && [...text].length <= LABEL_CHARS && !/[\u0000-\u001f\u007f]/.test(text), 'invalid_label');
  return text;
}

export async function inviteCreate(w, ident, input) {
  const sid = spaceId(input.space);
  const { s, role } = await loadMember(w, ident, sid, { meta: true });
  requireCan(s, role, 'members.manage');
  guardWrite(w, s, 'invite');
  check(input.role === 'editor' || input.role === 'viewer', 'invalid_role');
  if (RANK[input.role] >= RANK[role]) fail('forbidden', 403);
  const now = w.now();
  const exp = input.exp === undefined ? now + INVITE_DEFAULT : input.exp;
  check(Number.isSafeInteger(exp) && exp > now && exp <= now + INVITE_MAX, 'invalid_expiry');
  const named = input.named;
  const label = labelOf(input.label);
  check(label === undefined || named === undefined, 'invalid_label');
  const max = named !== undefined ? 1 : input.max ?? LIMITS.members;
  check(Number.isSafeInteger(max) && max >= 1 && max <= 1000, 'invalid_max');
  const index = (await w.kv.get(K.invs(sid))) ?? {};
  const expired = Object.keys(index).filter((hash) => !(index[hash]?.exp > now));
  if (Object.keys(index).length - expired.length >= MAX_INVITES) fail('invite_limit', 409);
  // Expired named invites stay indexed until maintenance unshares their stubs.
  const stale = expired.filter((hash) => !index[hash]?.stub);
  if (stale.length) w.waitUntil(ignore(w.kv.remove(K.invs(sid), stale)));
  await kvBudget(w, sid, 'inv', ident.uuid, { windowMs: DAY, limit: 50 });
  let token;
  let hash;
  let record;
  if (named !== undefined) {
    check(typeof named === 'string' && USERNAME.test(named), 'invalid_username');
    const kind = kindOf(s);
    const title = titleOf(kind, s.meta) ?? '';
    const owner = await w.owner();
    const invite = randomHex(16);
    hash = await sha256Hex(invite);
    await w.kv.set(K.stub(invite), { worker: w.workerName, space: sid, kind, title, ownerName: owner.username, role: input.role, exp, invite }, { expireAt: exp });
    let share;
    try {
      share = await w.kv.share({ prefix: K.stubPrefix(invite), recipient: named, access: 'read', label: shareLabel(`${title} · from ${owner.username}`) });
    } catch (error) {
      await ignore(w.kv.del(K.stub(invite)));
      shareFailure(error);
    }
    // Shares name their holder by current username, never by uuid.
    const holder = typeof share.holder === 'string' && share.holder ? share.holder : named;
    const members = await recordsUnder(w, sid, 'm');
    if (members.some(({ value }) => active(value) && typeof value.username === 'string' && value.username.toLowerCase() === holder.toLowerCase())) {
      await Promise.all([ignore(w.kv.unshare(share.handle)), ignore(w.kv.del(K.stub(invite)))]);
      fail('already_member', 409);
    }
    record = { role: input.role, exp, max: 1, by: ident.uuid, created: now, named, holder, handle: share.handle, stub: invite };
  } else {
    token = randomHex(16);
    hash = await sha256Hex(token);
    record = { role: input.role, exp, max, by: ident.uuid, created: now, ...(label ? { label } : {}) };
  }
  await w.kv.set(K.inv(sid, hash), record, { expireAt: exp + KEEP });
  await w.kv.update(K.invs(sid), { [hash]: { ...summary(record), ...(record.handle ? { handle: record.handle, stub: record.stub } : {}) } });
  return { invite: { id: hash, ...summary(record) }, ...(token ? { token } : {}) };
}

/** Maps a refused stub share to the worker's named-invite errors. */
function shareFailure(error) {
  switch (error?.code) {
    case 'kv_handles_disabled': return fail('named_invites_unavailable', 409);
    case 'subject_does_not_exist': case 'invalid_recipient': return fail('user_not_found', 404);
    case 'bad_request': return fail('invalid_username', 400);
    case 'recipient_not_accepting_shares': return fail('recipient_refused', 409);
    case 'events_kv_handle_not_delegated': return fail('share_consent_required', 409);
    case 'events_kv_handle_limit_reached': return fail('share_limit', 409);
    case 'too_many_requests': return fail('rate_limited', 429, { retryAfter: 60 });
    default: throw error;
  }
}

/**
 * Whether the caller holds a named invite's stub share. The record keeps the holder's username from when it was shared;
 * after a rename, re-sharing the stub to the caller's uuid answers with the same handle only for its holder.
 */
async function holdsNamedInvite(w, record, ident) {
  if (typeof record?.holder !== 'string' || !record.handle || !record.stub) return false;
  if (typeof ident.username === 'string' && ident.username.toLowerCase() === record.holder.toLowerCase()) return true;
  try {
    const share = await w.kv.share({ prefix: K.stubPrefix(record.stub), recipient: { uid: ident.uuid }, access: 'read' });
    if (share?.handle === record.handle) return true;
    if (typeof share?.handle === 'string') await ignore(w.kv.unshare(share.handle));
  } catch { /* not provable */ }
  return false;
}

export async function inviteList(w, ident, input) {
  const sid = spaceId(input.space);
  const { s, role } = await loadMember(w, ident, sid, { meta: true });
  requireCan(s, role, 'members.manage');
  const now = w.now();
  const [stored, xin] = await w.kv.getMany([K.invs(sid), K.xin(sid)]);
  const index = stored ?? {};
  const live = Object.entries(index).filter(([hash, item]) => HEX64.test(hash) && item && item.exp > now);
  const uses = await w.kv.getMany(live.map(([hash]) => K.invc(sid, hash)));
  const seats = xin && now - (Number(xin.at) || 0) < SEAT_DAYS ? await pendingSeats(w, sid) : [];
  return {
    invites: live.map(([hash, item], i) => ({ id: hash, ...summary(item), uses: uses[i] ?? 0 })).filter((item) => item.uses < item.max),
    ...(seats.length ? { seats } : {}),
  };
}

// Seats of a moved trip live 30 days (transfer GRACE).
const SEAT_DAYS = 30 * DAY;

/** Former members of a moved trip who may still rejoin with `transfer.join`: `[{uuid, username, role, exp}]`. */
async function pendingSeats(w, sid) {
  const records = await recordsUnder(w, sid, 'xseat');
  return records.filter(({ uuid, value }) => isUuid(uuid) && value && !value.claimed && value.exp > w.now())
    .map(({ uuid, value }) => ({ uuid, username: typeof value.username === 'string' ? value.username : '', role: value.role, exp: value.exp }));
}

/** Removing someone who only holds a seat claims it, so they can no longer rejoin a moved trip. */
async function revokeSeat(w, ident, input, notMember) {
  const sid = spaceId(input.space);
  const uuid = uuidOf(input.uuid);
  const { s, role } = await loadMember(w, ident, sid, { meta: true });
  const seat = await w.kv.get(K.seat(sid, uuid));
  if (!seat || seat.claimed || !(seat.exp > w.now())) throw notMember;
  if (RANK[seat.role] >= RANK[role]) fail('forbidden', 403);
  await w.kv.update(K.seat(sid, uuid), { claimed: w.now(), revoked: true });
  return { removed: true, seat: true, rev: s.rev ?? 0 };
}

export async function inviteRevoke(w, ident, input) {
  const sid = spaceId(input.space);
  check(typeof input.id === 'string' && HEX64.test(input.id), 'invalid_invite');
  const { s, role } = await loadMember(w, ident, sid, { meta: true });
  requireCan(s, role, 'members.manage');
  const [record, index] = await w.kv.getMany([K.inv(sid, input.id), K.invs(sid)]);
  const known = record ?? own(index, input.id);
  if (!known || record?.revoked) fail('not_found', 404);
  if (RANK[known.role] >= RANK[role]) fail('forbidden', 403);
  const now = w.now();
  await w.kv.set(K.inv(sid, input.id), { ...summary(known), ...(known.holder ? { holder: known.holder } : {}), revoked: now }, { expireAt: Math.max(Number(known.exp) || 0, now) + KEEP });
  await cleanupInvite(w, sid, input.id, known, { keep: true });
  return { revoked: true };
}

/** Reads an invite plus `extra` keys in one batched get. */
async function readInvite(w, sid, ident, input, extra = []) {
  await hostedGate(w, sid, ident.uuid);
  // An account at the failed-join limit in this isolate costs no further reads.
  if (!w.limiter.check(joinFails(sid, ident), FAILED_JOINS, FAIL_WINDOW)) fail('rate_limited', 429, { retryAfter: 600 });
  const failKey = K.fail(sid, ident.uuid, w.now());
  const named = input.invite !== undefined;
  const secret = named ? input.invite : input.token;
  const wellFormed = typeof secret === 'string' && HEX32.test(secret) && (input.invite === undefined || input.token === undefined);
  const hash = wellFormed ? await sha256Hex(secret) : null;
  const keys = [...new Set([failKey, ...(hash ? [K.inv(sid, hash), K.invc(sid, hash)] : []), ...extra])];
  const values = await w.kv.getMany(keys);
  const got = new Map(keys.map((key, i) => [key, values[i]]));
  for (const key of extra) absorb(w, sid, key, got.get(key));
  return { got, hash, failKey, named };
}

/** Validates a read invite; failures count toward the per-account limiter. */
async function validInvite(w, sid, ident, s, { got, hash, failKey, named }) {
  if ((Number(got.get(failKey)) || 0) >= FAILED_JOINS) {
    w.limiter.take(joinFails(sid, ident), FAILED_JOINS, FAIL_WINDOW, FAILED_JOINS);
    fail('rate_limited', 429, { retryAfter: 600 });
  }
  const record = hash ? got.get(K.inv(sid, hash)) : null;
  const uses = hash ? Number(got.get(K.invc(sid, hash))) || 0 : 0;
  const removed = Number(recordOf(s, ident.uuid)?.removed) || 0;
  // A stopped named invite is only told apart by username; a live one may ask Puter who holds its stub.
  const live = record && !record.revoked && record.exp > w.now();
  const foreign = !record || (named
    ? !record.named || !(live ? await holdsNamedInvite(w, record, ident) : typeof ident.username === 'string' && ident.username.toLowerCase() === String(record.holder ?? '').toLowerCase())
    : Boolean(record.named));
  // Someone else's named invite, or one older than the caller's removal, reads as unknown.
  const reason = foreign || (removed && record.created <= removed) ? 'invalid'
    : record.revoked ? 'revoked'
      : !(record.exp > w.now()) ? 'expired'
        : uses >= record.max ? 'used' : null;
  if (reason) {
    w.limiter.take(joinFails(sid, ident), FAILED_JOINS, FAIL_WINDOW);
    const count = await w.kv.incr(failKey);
    if (count === 1) w.waitUntil(ignore(w.kv.expire(failKey, 1200)));
    fail('invite_invalid', 404, { reason });
  }
  return record;
}

export async function joinPreview(w, ident, input) {
  const sid = spaceId(input.space);
  throttle(w, `preview:${ident.uuid}`, 30, 60_000);
  const read = await readInvite(w, sid, ident, input, [K.acl(sid), K.member(sid, ident.uuid), ...staleKeys(w, sid, { meta: true })]);
  const s = await loadSpace(w, sid, { meta: true, caller: ident.uuid });
  const record = await validInvite(w, sid, ident, s, read);
  const owner = await w.owner();
  return { title: titleOf(kindOf(s), s.meta) ?? '', owner: owner.username, role: record.role, kind: kindOf(s), exp: record.exp };
}

function membership(sid, s, role, rev, access, mode) {
  return {
    space: sid, kind: kindOf(s), role, rev,
    ...(access.read && access.write ? { handles: { read: access.read, write: access.write } } : {}),
    files: filesInfo(s.doc, mode, access, role === 'owner'),
  };
}

/** Join by link `{token}` or named `{invite}` (architecture §11). Joining again returns the membership. */
export async function join(w, ident, input) {
  const sid = spaceId(input.space);
  throttle(w, `join:${ident.uuid}`, 20, 60_000);
  const memberKey = K.entity(sid, 'member', ident.uuid);
  const read = await readInvite(w, sid, ident, input, [
    K.acl(sid), K.member(sid, ident.uuid), K.entity(sid, 'meta', 'meta'), K.rev(sid), K.count(sid), K.filesMode(sid), K.handles(sid, ident.uuid), memberKey,
  ]);
  const { got, hash } = read;
  const s = await loadSpace(w, sid, { meta: true, caller: ident.uuid });
  let role = roleOf(s, ident.uuid);
  let rev = s.rev ?? 0;
  if (!role) {
    guardWrite(w, s, 'join');
    const record = await validInvite(w, sid, ident, s, read);
    check((Number(own(got.get(K.count(sid)), 'members')) || 0) < LIMITS.members, 'space_full', 409);
    if (!record.named && (await w.kv.incr(K.invc(sid, hash))) > record.max) fail('invite_invalid', 404, { reason: 'used' });
    role = record.role;
    const entry = { role, username: ident.username, joined: w.now(), via: record.named ? 'named' : 'link' };
    await w.kv.set(K.member(sid, ident.uuid), entry);
    setMember(w, sid, ident.uuid, entry);
    const current = got.get(memberKey);
    const fields = { name: ident.username || 'member', role, color: colorFor(ident.uuid) };
    const item = current && !current.deleted ? { t: 'member', id: ident.uuid, set: fields } : { t: 'member', id: ident.uuid, put: fields };
    rev = (await workerChange(w, sid, ident.uuid, [item], { kind: kindOf(s), got, revive: true, deltas: { members: 1 } })).rev;
    if (record.named) w.waitUntil(cleanupInvite(w, sid, hash, record));
  }
  const handles = got.get(K.handles(sid, ident.uuid));
  const { access, mode } = role === 'owner'
    ? { access: handles ?? {}, mode: got.get(K.filesMode(sid)) }
    : await ensureAccess(w, sid, s, ident, role, handles, got.get(K.filesMode(sid)));
  return membership(sid, s, role, rev, access, mode);
}

export async function inviteDecline(w, ident, input) {
  const sid = spaceId(input.space);
  check(typeof input.invite === 'string' && HEX32.test(input.invite), 'invalid_invite');
  throttle(w, `decline:${ident.uuid}`, 20, 60_000);
  await hostedGate(w, sid, ident.uuid);
  const hash = await sha256Hex(input.invite);
  const record = await w.kv.get(K.inv(sid, hash));
  if (!record?.named || record.revoked || !(await holdsNamedInvite(w, record, ident))) fail('not_found', 404);
  await cleanupInvite(w, sid, hash, record);
  return { declined: true };
}

async function removeMember(w, sid, s, target, actor) {
  const now = w.now();
  const record = recordOf(s, target);
  // A path write, so a concurrent role change in the same region cannot erase the removal; never earlier than the join.
  const removed = Math.max(now, (Number(record?.joined) || 0) + 1);
  await w.kv.update(K.member(sid, target), { removed });
  setMember(w, sid, target, { ...record, removed });
  const [handles, entity] = await w.kv.getMany([K.handles(sid, target), K.entity(sid, 'member', target)]);
  const result = entity && !entity.deleted
    ? await workerChange(w, sid, actor, [{ t: 'member', id: target, del: true }], { kind: kindOf(s), got: new Map([[K.entity(sid, 'member', target), entity]]), deltas: { members: -1 } })
    : null;
  await settleRevocation(w, sid, target, record?.username, handles);
  await ignore(w.kv.del(K.feed(sid, target)));
  w.feeds.delete(`${sid}:${target}`);
  w.waitUntil(purgeRegion(w, sid, target).catch(() => {}));
  return { removed: true, rev: result?.rev ?? s.rev ?? 0 };
}

/** Loads a target member fresh and checks the caller may act on it. */
async function target(w, ident, input, { role: newRole } = {}) {
  const sid = spaceId(input.space);
  const uuid = uuidOf(input.uuid);
  const { s, role } = await loadMember(w, ident, sid, { meta: true });
  requireCan(s, role, 'members.manage');
  guardWrite(w, s, 'members');
  await loadRecords(w, sid, [uuid], { fresh: true });
  const targetRole = roleOf(s, uuid);
  if (!targetRole) fail('not_member', 404);
  if (uuid === ident.uuid || RANK[targetRole] >= RANK[role] || (newRole && RANK[newRole] >= RANK[role])) fail('forbidden', 403);
  return { sid, s, uuid, targetRole };
}

export async function memberRemove(w, ident, input) {
  let found;
  try { found = await target(w, ident, input); } catch (error) {
    if (error?.code === 'not_member' && error.status === 404) return revokeSeat(w, ident, input, error);
    throw error;
  }
  return removeMember(w, found.sid, found.s, found.uuid, ident.uuid);
}

export async function leave(w, ident, input) {
  const sid = spaceId(input.space);
  const { s, role } = await loadMember(w, ident, sid);
  if (role === 'owner') fail('owner_cannot_leave', 409);
  return removeMember(w, sid, s, ident.uuid, ident.uuid);
}

export async function memberRole(w, ident, input) {
  check(input.role === 'editor' || input.role === 'viewer', 'invalid_role');
  const { sid, s, uuid, targetRole } = await target(w, ident, input, { role: input.role });
  if (targetRole === input.role) return { role: input.role, rev: s.rev ?? 0 };
  await w.kv.update(K.member(sid, uuid), { role: input.role });
  setMember(w, sid, uuid, { ...recordOf(s, uuid), role: input.role });
  const result = await upsertMember(w, sid, s, ident.uuid, uuid, { role: input.role });
  if (!can(input.role, 'files.upload', permsOf(s))) {
    const record = await w.kv.get(K.handles(sid, uuid));
    if (record?.inbox) {
      await ignore(dropInbox(w, sid, uuid, recordOf(s, uuid)?.username));
      await w.kv.set(K.handles(sid, uuid), { ...record, inbox: null });
    }
  }
  return { role: input.role, rev: result?.rev ?? s.rev ?? 0 };
}

/** Owner maintenance: revoke grants held by people who are no longer members, including handles and file shares with no record. */
export async function reconcileGrants(w, sid, records) {
  await reconcileFileShares(w, sid).catch(() => {});
  const s = await loadRecords(w, sid, records.map(({ uuid }) => uuid), { fresh: true });
  for (const { uuid, value } of records) {
    if (!value || (active(recordOf(s, uuid)) && !value.revoke)) continue;
    await settleRevocation(w, sid, uuid, value.username ?? recordOf(s, uuid)?.username, value);
  }
  const live = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const listed = await w.kv.listSharedByMe({ limit: 200, ...(cursor ? { cursor } : {}) });
    for (const item of listed?.items ?? []) {
      if (!item.revokedAt && typeof item.prefix === 'string' && item.prefix.startsWith(K.shared(sid))) live.push(item);
    }
    cursor = listed?.cursor;
    if (!cursor) break;
  }
  // Handles a member revoked or lost are dropped from their record, so the next `open` mints fresh ones.
  if (!cursor) {
    const ids = new Set(live.map((item) => item.handle));
    for (const { uuid, value } of records) {
      if (!value || value.revoke || !active(recordOf(s, uuid)) || !(value.read || value.write)) continue;
      if (!ids.has(value.read) || !ids.has(value.write)) await ignore(w.kv.remove(K.handles(sid, uuid), ['read', 'write', 'minted']));
    }
  }
  if (!live.length) return;
  // A write handle names its member in its prefix. A read handle names only its holder's current username, so it stays
  // while its id is on an active member's grant record or its holder goes by an active member's name.
  const members = new Map((await recordsUnder(w, sid, 'm')).map(({ uuid, value }) => [uuid, value]));
  const recorded = new Set(records.filter(({ uuid, value }) => value && !value.revoke && active(members.get(uuid))).map(({ value }) => value.read));
  const names = new Set([...members.values()].filter((value) => active(value) && typeof value.username === 'string').map((value) => value.username.toLowerCase()));
  for (const item of live) {
    const region = /^u:([^:]+):$/.exec(item.prefix.slice(K.shared(sid).length))?.[1];
    const member = region ? active(members.get(region)) : recorded.has(item.handle) || (typeof item.holder === 'string' && names.has(item.holder.toLowerCase()));
    if (!member) await ignore(w.kv.unshare(item.handle));
  }
}
