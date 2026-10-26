import { newId, isId } from '../../src/shared/ids.js';
import { LIMITS } from '../../src/shared/limits.js';
import { KINDS } from '../../src/shared/protocol.js';
import { validateEntity } from '../../src/shared/schema/index.js';
import { bytesResponse, check, fail } from '../http.js';
import { K, P, spaceId } from '../keys.js';
import { workerChange } from './commit.js';
import { cleanupInvite, colorFor, revokeAccess } from './members.js';
import { purgeSpace, recordsUnder } from './scan.js';
import { collect, gzip } from './snapshot.js';
import { active, forget, loadMember, loadSpace } from './space.js';
import { pool } from './store.js';
import { throttle } from './limits.js';

async function requireOwner(w, ident) {
  const owner = await w.owner();
  if (ident.uuid !== owner.uuid) fail('forbidden', 403);
  return owner;
}

/** Owner only. `{kind, meta, space?}`; a client-chosen id makes retries idempotent. */
export async function spaceCreate(w, ident, input) {
  const owner = await requireOwner(w, ident);
  check(KINDS.includes(input.kind), 'invalid_kind');
  const kind = input.kind;
  const sid = input.space === undefined ? newId() : input.space;
  check(isId(sid), 'invalid_space');
  validateEntity(kind, 'meta', input.meta);
  throttle(w, `create:${owner.uuid}`, 20, 60_000);
  const metaKey = K.entity(sid, 'meta', 'meta');
  const memberKey = K.entity(sid, 'member', owner.uuid);
  const [cfg, idx, doc, meta, member] = await w.kv.getMany([K.cfg, K.idx, K.acl(sid), metaKey, memberKey]);
  if (doc) {
    if (doc.deleted || doc.k !== kind || doc.owner !== owner.uuid) fail('exists', 409);
    // A retry after the doc write but before the `idx` write finishes the create.
    if (!Object.hasOwn(idx ?? {}, sid)) await w.kv.update(K.idx, { [sid]: { k: kind, created: doc.created } });
    w.hostedSet({ ...idx, [sid]: { k: kind, created: doc.created } });
    return { space: sid, kind, rev: (await w.kv.get(K.rev(sid))) ?? 0 };
  }
  check(Object.keys(idx ?? {}).length < LIMITS.spaces, 'space_limit', 409);
  if (cfg && cfg.owner !== owner.uuid) fail('owner_mismatch', 500);
  const now = w.now();
  if (!cfg) await w.kv.set(K.cfg, { owner: owner.uuid, created: now, build: w.build });
  const files = await w.fs.mkdir(P.files(sid), { createMissingParents: true });
  const inbox = await w.fs.mkdir(P.inboxOf(sid, owner.uuid), { createMissingParents: true });
  await w.kv.setMany([
    { key: K.secrets(sid), value: { k: kind, shareTokenHash: null, shareExp: null } },
    { key: K.member(sid, owner.uuid), value: { role: 'owner', username: owner.username, joined: now, via: 'create' } },
    { key: K.handles(sid, owner.uuid), value: { inbox: inbox.uid } },
    { key: K.count(sid), value: { e: 0, day: 0, place: 0, bytes: 0, members: 1 } },
  ]);
  const result = await workerChange(w, sid, owner.uuid, [
    { t: 'meta', id: 'meta', put: input.meta },
    { t: 'member', id: owner.uuid, put: { name: owner.username || 'owner', role: 'owner', color: colorFor(owner.uuid) } },
  ], { kind, got: new Map([[metaKey, meta], [memberKey, member]]) });
  // The space doc is written last so a failed create can be retried with the same id.
  await w.kv.set(K.acl(sid), { k: kind, owner: owner.uuid, created: now, folders: { files: files.uid } });
  await w.kv.update(K.idx, { [sid]: { k: kind, created: now } });
  w.hostedSet({ ...idx, [sid]: { k: kind, created: now } });
  forget(w, sid);
  return { space: sid, kind, rev: result?.rev ?? 1 };
}

export async function spaceList(w, ident) {
  await requireOwner(w, ident);
  const [idx, purges] = await w.kv.getMany([K.idx, K.purge]);
  if (purges && Object.keys(purges).length) w.waitUntil(resumePurge(w, Object.keys(purges)[0]).catch(() => {}));
  return { spaces: Object.entries(idx ?? {}).filter(([id, item]) => isId(id) && item).map(([id, item]) => ({ id, kind: item.k, created: item.created })) };
}

/** Owner export: every entity, all messages, tombstones and the member list, gzipped. */
export async function spaceExport(w, ident, input) {
  await requireOwner(w, ident);
  const sid = spaceId(input.space);
  const { s } = await loadMember(w, ident, sid);
  throttle(w, `export:${sid}`, 2, 60_000);
  const { snapshot, complete } = await collect(w, sid, s.doc.k, { everyMessage: true });
  if (!complete) fail('space_too_large', 413);
  const members = (await recordsUnder(w, sid, 'm')).filter(({ value }) => active(value))
    .map(({ uuid, value }) => ({ uuid, role: value.role, username: value.username, joined: value.joined }));
  const bytes = await gzip(JSON.stringify({ format: 'trips-export', version: 1, space: sid, ...snapshot, members }));
  return bytesResponse(bytes, { type: 'application/gzip' });
}

async function resumePurge(w, sid) {
  const complete = await purgeSpace(w, sid);
  await w.fs.delete(P.space(sid), { recursive: true }).catch(() => {});
  if (complete) await w.kv.remove(K.purge, [sid]);
}

/** Owner delete, authorized by the space doc so a retry after a partial failure still works. Every step can repeat. */
export async function spaceDelete(w, ident, input) {
  const owner = await requireOwner(w, ident);
  const sid = spaceId(input.space);
  const s = await loadSpace(w, sid, { fresh: true });
  if (s.doc.owner !== owner.uuid) fail('forbidden', 403);
  const now = w.now();
  await w.kv.set(K.secrets(sid), { k: s.doc.k, shareTokenHash: null, shareExp: null });
  const members = (await recordsUnder(w, sid, 'm')).filter(({ uuid, value }) => value && uuid !== owner.uuid);
  await pool(members, 4, ({ uuid }) => w.kv.update(K.member(sid, uuid), { removed: now }));
  const grants = await w.kv.getMany(members.map(({ uuid }) => K.handles(sid, uuid)));
  await pool(members, 4, ({ uuid, value }, i) => revokeAccess(w, sid, uuid, value.username, grants[i]));
  const invites = (await w.kv.get(K.invs(sid))) ?? {};
  await pool(Object.entries(invites), 4, ([hash, item]) => cleanupInvite(w, sid, hash, item));
  await w.kv.update(K.purge, { [sid]: now });
  await w.kv.set(K.acl(sid), { ...s.doc, deleted: now });
  await w.kv.remove(K.idx, [sid]);
  w.hostedRemove(sid);
  forget(w, sid);
  w.waitUntil(resumePurge(w, sid).catch(() => {}));
  return { deleted: true };
}
