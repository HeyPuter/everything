import { DomainError } from '../../src/shared/errors.js';
import { isId, isUuid } from '../../src/shared/ids.js';
import { LIMITS, TIMING } from '../../src/shared/limits.js';
import { can } from '../../src/shared/perms.js';
import { applyPatch, authorizeOperation, validateOperation } from '../../src/shared/operations.js';
import { plainObject, safeKey } from '../../src/shared/schema/dsl.js';
import { validateEntity } from '../../src/shared/schema/index.js';
import { HttpError, check, fail } from '../http.js';
import { K, byteLength, own, spaceId } from '../keys.js';
import { sweepInboxes } from './inbox.js';
import { DAY, HOUR, meter, metered, throttle } from './limits.js';
import { persist } from './log.js';
import { absorb, guardWrite, kindOf, loadMember, loadSpace, permsOf, requireMember, staleKeys } from './space.js';

export const AUTHOR_TYPES = new Set(['note', 'link', 'poll', 'msg']);
const TYPE = /^[a-z][a-zA-Z0-9]{0,31}$/;
// `collab` (notes, links, polls) has its own cap, so members who may only post can't fill the trip.
export const COLLAB_CAP = 2_000;
const CAPS = Object.freeze({ e: LIMITS.entities, day: LIMITS.days, place: LIMITS.places, collab: COLLAB_CAP });
const COLLAB_TYPES = new Set(['note', 'link', 'poll']);
const WORKER_TYPES = new Set(['meta', 'member', 'file']);
// Per member: the minute cap in isolate memory, the day cap on a KV window counter. Heavy editing of a large note
// stays well under the minute cap.
const WRITE_BYTES = Object.freeze({ minute: 32 * 1024 ** 2, day: 512 * 1024 ** 2 });
const WRITE_FLOOR = 1024 ** 2;
// Creates per member per hour (per isolate): a speed bump against filling the space caps in one burst.
const CREATES = Object.freeze({ viewer: 500, editor: 5_000, owner: 20_000 });

const clientFields = (entity) => {
  const { id: _id, v: _v, rev: _rev, upd: _upd, by: _by, cr: _cr, ...rest } = entity;
  return rest;
};
const canonical = (value) => JSON.stringify(value, (_, item) => (plainObject(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1))) : item));
const isLive = (value) => Boolean(value && !value.deleted);

/** Names the op element a 4xx belongs to (data-model §6), so the client parks only that one. */
function tagged(error, opId) {
  if ((error instanceof HttpError || error instanceof DomainError) && error.status >= 400 && error.status < 500 && error.status !== 429) {
    error.extra = { ...error.extra, op: opId };
  }
  return error;
}

function jsonSafe(value, depth = 0) {
  check(depth <= LIMITS.pathDepth, 'invalid_depth');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') { check(Number.isFinite(value), 'invalid_number'); return; }
  if (Array.isArray(value)) { check(value.length <= 10_000, 'invalid_array'); value.forEach((item) => jsonSafe(item, depth + 1)); return; }
  check(plainObject(value), 'invalid_object');
  for (const [key, item] of Object.entries(value)) { check(safeKey(key), 'invalid_key'); jsonSafe(item, depth + 1); }
}

/** Domain-op envelope check against the worker registry (op-specific `validate` follows). */
function domainDef(w, op) {
  check(Object.keys(op).every((key) => ['opId', 'do', 'args'].includes(key)) && typeof op.do === 'string'
    && Object.hasOwn(w.ops.domainOps, op.do) && plainObject(op.args), 'invalid_domain_op');
  jsonSafe(op.args);
  return w.ops.domainOps[op.do];
}

function counted(t) {
  if (t === 'msg' || WORKER_TYPES.has(t)) return [];
  if (t === 'day' || t === 'place') return ['e', t];
  return COLLAB_TYPES.has(t) ? ['e', 'collab'] : ['e'];
}

/** Applies ops to a working copy of the entities read in one batched get. */
export class Batch {
  constructor(w, { sid, kind, uid, role, perms, got, trusted = false }) {
    Object.assign(this, { w, sid, kind, uid, role, perms, got, trusted });
    this.now = w.now();
    this.working = new Map();
    this.startV = new Map();
    this.writes = new Map();
    this.authors = new Map();
    this.pollvoted = new Set();
    this.replays = [];
    this.deltas = {};
  }

  current(key) {
    if (!this.working.has(key)) {
      const value = this.got.get(key) ?? null;
      this.working.set(key, value);
      this.startV.set(key, value?.v);
    }
    return this.working.get(key);
  }

  live(t, id) {
    const value = this.current(K.entity(this.sid, t, id));
    return isLive(value) ? structuredClone({ t, ...value }) : null;
  }

  bump(t, sign) { for (const name of counted(t)) this.deltas[name] = (this.deltas[name] ?? 0) + sign; }

  record(key, write) {
    const previous = this.writes.get(key);
    if (previous) {
      write.created = previous.created || write.created;
      write.before = previous.before;
      if (write.mode !== 'del') write.mode = write.created ? 'put' : 'full';
      if (previous.created && write.mode === 'del') {
        this.writes.delete(key);
        this.authors.delete(K.author(this.sid, write.t, write.id));
        return;
      }
      write.fields = [...new Set([...(previous.fields ?? []), ...(write.fields ?? [])])];
    }
    this.writes.set(key, write);
  }

  hook(op, before, after) {
    const hook = own(this.w.ops.typeHooks, `${this.kind}/${op.t}`);
    hook?.check?.({ op, before, after, uid: this.uid, role: this.role, perms: this.perms, kind: this.kind, space: this.sid, get: (t, id) => this.live(t, id) });
  }

  apply(op) {
    if (Object.hasOwn(op, 'do')) return this.domain(op);
    validateOperation(op, { kind: this.kind });
    return this.entityOp(op, op.opId);
  }

  /** Domain ops may only see and write entities their `reads` listed; anything else would look absent and be overwritten. */
  declared(t, id) {
    const key = K.entity(this.sid, t, id);
    check(this.got.has(key), 'invalid_domain_result', 500);
    return key;
  }

  domain(op) {
    const def = domainDef(this.w, op);
    check(def.kinds.includes(this.kind), 'invalid_domain_op');
    const writes = def.plan({
      args: op.args, uid: this.uid, role: this.role, perms: this.perms, kind: this.kind, now: this.now,
      can: (action) => can(this.role, action, this.perms),
      get: (t, id) => { this.declared(t, id); return this.live(t, id); },
    });
    check(Array.isArray(writes) && writes.length <= LIMITS.commitWrites, 'invalid_domain_result', 500);
    const trusted = this.trusted;
    this.trusted = true;
    try {
      for (const write of writes) {
        check(plainObject(write) && !Object.hasOwn(write, 'do') && !Object.hasOwn(write, 'opId'), 'invalid_domain_result', 500);
        // Domain ops may patch meta and files but never create or delete worker-owned entities.
        check(write.t !== 'member' && !((write.put || write.del) && WORKER_TYPES.has(write.t)), 'worker_only', 403);
        const synthetic = { opId: op.opId, ...write };
        validateOperation(synthetic, { kind: this.kind });
        this.declared(synthetic.t, synthetic.id);
        this.entityOp(synthetic, op.opId);
      }
    } finally { this.trusted = trusted; }
  }

  entityOp(op, opId) {
    const { sid, kind, uid } = this;
    const key = K.entity(sid, op.t, op.id);
    const current = this.current(key);
    if (op.put) {
      if (current) {
        // A retried create whose first attempt already landed.
        if (isLive(current) && current.by === uid && canonical(clientFields(current)) === canonical(op.put) && !this.writes.has(key)) {
          this.replays.push({ opId, t: op.t, entity: current });
          return;
        }
        if (!(this.trusted && this.reviveWorkerTypes && WORKER_TYPES.has(op.t) && !isLive(current))) fail('already_exists', 409, { server: { t: op.t, ...current } });
      }
      if (!this.trusted) authorizeOperation(op, { kind, role: this.role, uid, perms: this.perms, now: this.now });
      const entity = { ...structuredClone(op.put), id: op.id, v: this.w.clock.tick(current?.v), rev: 0, upd: this.now, by: uid, cr: this.now };
      validateEntity(kind, op.t, entity, { server: true });
      this.hook(op, null, entity);
      this.working.set(key, entity);
      this.record(key, { t: op.t, id: op.id, key, mode: 'put', created: true, entity, fields: [] });
      if (AUTHOR_TYPES.has(op.t)) this.authors.set(K.author(sid, op.t, op.id), uid);
      if (op.t === 'poll' && Object.values(entity.votes ?? {}).some((votes) => votes.length > 0)) this.pollvoted.add(K.pollvoted(sid, op.id));
      this.bump(op.t, 1);
      return;
    }
    const entity = isLive(current) ? current : null;
    if (!this.trusted) {
      const authorKey = K.author(sid, op.t, op.id);
      const creator = AUTHOR_TYPES.has(op.t) ? (this.authors.get(authorKey) ?? this.got.get(authorKey) ?? undefined) : undefined;
      const pollHasVoted = op.t === 'poll' ? Boolean(this.got.get(K.pollvoted(sid, op.id)) || this.pollvoted.has(K.pollvoted(sid, op.id))) : undefined;
      // A base equal to the version at the start of this commit stays valid for later ops in the same commit.
      const seen = entity && op.base !== undefined && op.base === this.startV.get(key) ? { ...entity, v: op.base } : entity;
      try {
        authorizeOperation(op, { kind, role: this.role, uid, creator, entity: seen, pollHasVoted, perms: this.perms, now: this.now });
      } catch (error) {
        if (error instanceof DomainError && error.code === 'stale' && entity) throw Object.assign(error, { extra: { server: { t: op.t, ...entity } } });
        if (error instanceof DomainError && error.code === 'gone' && current) throw Object.assign(error, { extra: { server: { t: op.t, ...current } } });
        throw error;
      }
    } else if (!entity) fail('gone', 409, current ? { server: { t: op.t, ...current } } : undefined);
    const v = this.w.clock.tick(entity.v);
    if (op.del) {
      if (op.t === 'msg') {
        const next = { ...structuredClone(entity), text: '', deleted: true, v, upd: this.now, by: uid };
        delete next.react;
        validateEntity(kind, 'msg', next, { server: true });
        this.working.set(key, next);
        this.record(key, { t: op.t, id: op.id, key, mode: 'full', entity: next, before: entity, fields: ['deleted'] });
        return;
      }
      if (op.t === 'meta') fail('worker_only', 403);
      const tombstone = { id: op.id, t: op.t, deleted: true, rev: 0, v };
      this.hook(op, entity, null);
      this.working.set(key, tombstone);
      this.record(key, { t: op.t, id: op.id, key, mode: 'del', entity: tombstone, before: entity, fields: [] });
      this.bump(op.t, -1);
      return;
    }
    const next = applyPatch(kind, op.t, entity, op);
    Object.assign(next, { v, upd: this.now, by: uid });
    if (op.t === 'poll' && Object.entries(op.set ?? {}).some(([path, value]) => path.startsWith('votes.') && Array.isArray(value) && value.length > 0)) {
      this.pollvoted.add(K.pollvoted(sid, op.id));
    }
    check(byteLength(next) <= LIMITS.kvBytes, 'entity_too_large', 413);
    this.hook(op, entity, next);
    this.working.set(key, next);
    const fields = [...new Set([...Object.keys(op.set ?? {}), ...(op.unset ?? [])].map((path) => path.split('.')[0]))];
    this.record(key, { t: op.t, id: op.id, key, mode: 'patch', entity: next, before: entity, set: op.set ?? {}, unset: op.unset ?? [], fields });
  }

  checkCaps(count) {
    for (const [name, delta] of Object.entries(this.deltas)) {
      if (delta > 0 && Object.hasOwn(CAPS, name) && (Number(own(count, name)) || 0) + delta > CAPS[name]) fail('space_full', 409, { limit: name });
    }
  }

  get writeList() { return [...this.writes.values()]; }
}

/** Extra entities the type hooks for `op.t` read through `get` (hooks run before the op is validated). */
function hookReads(w, op) {
  const refs = [];
  for (const [key, hook] of Object.entries(w.ops.typeHooks)) {
    if (typeof hook?.reads !== 'function' || key.slice(key.indexOf('/') + 1) !== op.t) continue;
    const listed = hook.reads(op);
    check(Array.isArray(listed) && listed.length <= LIMITS.commitWrites && listed.every((ref) => typeof ref?.t === 'string' && TYPE.test(ref.t) && (isId(ref.id) || isUuid(ref.id))), 'invalid_operation');
    refs.push(...listed.map((ref) => ({ t: ref.t, id: ref.id })));
  }
  return refs;
}

function refsOf(w, op) {
  if (Object.hasOwn(op, 'do')) {
    const def = domainDef(w, op);
    def.validate(op.args);
    const refs = def.reads(op.args);
    check(Array.isArray(refs) && refs.length <= LIMITS.commitWrites, 'invalid_domain_op');
    return refs;
  }
  check(typeof op.t === 'string' && TYPE.test(op.t) && typeof op.id === 'string', 'invalid_operation');
  return [{ t: op.t, id: op.id, put: Object.hasOwn(op, 'put'), set: Object.hasOwn(op, 'set') }, ...hookReads(w, op)];
}

/**
 * Per-member budget on the KV bytes the owner pays for. `update` bills the whole item, so a small patch
 * (even a viewer's `$self` path) on a big entity counts in full, and the change record repeats it.
 */
async function chargeWrites(w, sid, uuid, role, writes) {
  const bytes = writes.reduce((sum, write) => sum + 2 * Math.max(byteLength(write.entity), write.before ? byteLength(write.before) : 0), 0);
  // A batch that alone exceeds the minute budget could never pass; a batch-level 413 makes the client split it.
  if (bytes > WRITE_BYTES.minute) fail('batch_too_large', 413);
  const created = writes.filter((write) => write.created).length;
  if (created) throttle(w, `creates:${sid}:${uuid}`, CREATES[role] ?? CREATES.viewer, HOUR, created);
  metered(w, sid, 'wb', uuid, { windowMs: DAY });
  throttle(w, `wbytes:${sid}:${uuid}`, WRITE_BYTES.minute, 60_000, bytes);
  await meter(w, sid, 'wb', uuid, bytes, { windowMs: DAY, limit: WRITE_BYTES.day, floor: WRITE_FLOOR });
}

/** `{ops:[…]}` → `{rev, ents, del, done}` (architecture §5). */
export async function commit(w, ident, input) {
  const sid = spaceId(input.space);
  const { ops } = input;
  check(Array.isArray(ops) && ops.length >= 1 && ops.length <= LIMITS.commitWrites, 'invalid_commit');
  const seen = new Set();
  for (const op of ops) {
    check(plainObject(op) && isId(op.opId) && !seen.has(op.opId), 'invalid_operation');
    seen.add(op.opId);
  }
  throttle(w, `commit:${sid}:${ident.uuid}`, 120, 60_000);
  throttle(w, `ops:${sid}:${ident.uuid}`, 3000, 60_000, ops.length);
  // Membership first (usually cached), so outsiders never cost the owner the big read.
  await loadMember(w, ident, sid);
  const keys = new Set(staleKeys(w, sid, { uuid: ident.uuid, meta: true }));
  let counts = false;
  for (const op of ops) {
    keys.add(K.opdone(sid, op.opId));
    let refs;
    try { refs = refsOf(w, op); } catch (error) { throw tagged(error, op.opId); }
    for (const ref of refs) {
      keys.add(K.entity(sid, ref.t, ref.id));
      if (AUTHOR_TYPES.has(ref.t) && !ref.put) keys.add(K.author(sid, ref.t, ref.id));
      if (ref.t === 'poll' && ref.set) keys.add(K.pollvoted(sid, ref.id));
    }
    if (Object.hasOwn(op, 'do') || Object.hasOwn(op, 'put') || Object.hasOwn(op, 'del')) counts = true;
  }
  if (counts) keys.add(K.count(sid));
  const list = [...keys];
  check(list.length <= 1000, 'too_many_reads', 413);
  const values = await w.kv.getMany(list);
  const got = new Map(list.map((key, index) => [key, values[index]]));
  for (const [key, value] of got) absorb(w, sid, key, value);
  const s = await loadSpace(w, sid, { meta: true, uuid: ident.uuid });
  const role = requireMember(s, ident.uuid);
  guardWrite(w, s, 'commit');
  const done = {};
  const pending = ops.filter((op) => {
    const rev = got.get(K.opdone(sid, op.opId));
    if (Number.isSafeInteger(rev) && rev > 0) { done[op.opId] = rev; return false; }
    return true;
  });
  const replayed = () => {
    const ents = []; const del = [];
    for (const op of ops) {
      if (Object.hasOwn(op, 'do') || !done[op.opId]) continue;
      const value = got.get(K.entity(sid, op.t, op.id));
      // A deleted message is a soft delete, so it stays an entity as in the original answer.
      if (value?.deleted && op.t !== 'msg') del.push({ t: op.t, id: op.id, v: value.v });
      else if (value) ents.push({ t: op.t, ...value });
    }
    return { ents, del };
  };
  if (!pending.length) return { rev: Math.max(...Object.values(done)), ...replayed(), done };
  const batch = new Batch(w, { sid, kind: kindOf(s), uid: ident.uuid, role, perms: permsOf(s), got });
  for (const op of pending) {
    try { batch.apply(op); } catch (error) { throw tagged(error, op.opId); }
  }
  const writes = batch.writeList;
  check(writes.length <= LIMITS.commitWrites, 'too_many_writes', 413);
  batch.checkCaps(got.get(K.count(sid)));
  const opdoneItems = (rev) => pending.map((op) => ({ key: K.opdone(sid, op.opId), value: rev, expireAt: w.now() + TIMING.idempotency }));
  if (!writes.length) {
    const rev = Math.max(1, ...batch.replays.map((replay) => replay.entity.rev ?? 1), ...Object.values(done));
    const { ents, del } = replayed();
    await w.kv.setMany(opdoneItems(rev));
    for (const op of pending) done[op.opId] = rev;
    return { rev, ents: [...ents, ...batch.replays.map(({ t, entity }) => ({ t, ...entity }))], del, done };
  }
  await chargeWrites(w, sid, ident.uuid, role, writes);
  const extra = [...batch.authors].map(([key, value]) => ({ key, value }));
  const after = [
    ...pending.map((op) => ({ key: K.opdone(sid, op.opId), value: (rev) => rev, expireAt: w.now() + TIMING.idempotency })),
    ...[...batch.pollvoted].map((key) => ({ key, value: true })),
  ];
  const previous = replayed();
  const result = await persist(w, sid, ident.uuid, { writes, extra, after, deltas: batch.deltas });
  // A perms change can take `files.upload` away; the sweep drops those inboxes now.
  if (writes.some((write) => write.t === 'meta' && write.fields?.includes('perms'))) w.waitUntil(sweepInboxes(w, sid).catch(() => {}));
  for (const op of pending) done[op.opId] = result.rev;
  return {
    rev: result.rev,
    ents: [...previous.ents, ...result.ents, ...batch.replays.map(({ t, entity }) => ({ t, ...entity }))],
    del: [...previous.del, ...result.del],
    done,
  };
}

/** Worker-authored entity changes (members, meta toggles, files). Reads the touched entities in one batched get. */
export async function workerChange(w, sid, actor, items, { kind, got: provided, revive = false, deltas = {} } = {}) {
  let got = provided;
  if (!got) {
    const list = [...new Set(items.map((item) => K.entity(sid, item.t, item.id)))];
    const values = await w.kv.getMany(list);
    got = new Map(list.map((key, index) => [key, values[index]]));
  }
  const batch = new Batch(w, { sid, kind, uid: actor, role: 'owner', perms: {}, got, trusted: true });
  batch.reviveWorkerTypes = revive;
  for (const item of items) {
    const op = { opId: '0000000000000000', ...item };
    validateOperation(op, { kind });
    batch.entityOp(op, op.opId);
  }
  const writes = batch.writeList;
  if (!writes.length) return null;
  for (const [name, delta] of Object.entries(deltas)) batch.deltas[name] = (batch.deltas[name] ?? 0) + delta;
  return persist(w, sid, actor, { writes, deltas: batch.deltas });
}
