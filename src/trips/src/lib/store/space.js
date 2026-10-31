import { DomainError, invariant } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { createClock, compareHlc } from '../../shared/hlc.js';
import { DOMAIN_OPS, validateSpaceRef } from '../../shared/protocol.js';
import { LIMITS } from '../../shared/limits.js';
import { validateCommit, validateOperation, applyPatch } from '../../shared/operations.js';
import { entitySchema, validateEntity, validateTombstone, SERVER_FIELDS } from '../../shared/schema/index.js';
import { appendFeed, feedEntry, readFeed } from './feed.js';

const keyOf = (type, id) => `${type}:${id}`;
const typeOf = (key) => key.slice(0, key.indexOf(':'));
const empty = () => ({ rev: 0, confirmed: {}, pending: [], conflicts: [], batch: null });
const PARKED = new Set([400, 403, 409, 413, 422]);
const adapters = new Map();
// Revs of data this build could not validate, newest last.
const withSkipped = (list, rev) => [...(list ?? []).filter((item) => item !== rev), rev].slice(-20);

/** Domain ops show locally only through an adapter: `(args, {get, entities, uid, now}) => [{t, id, put|set|unset|del}]`. */
export function registerDomainAdapter(name, adapter) {
  invariant(DOMAIN_OPS.includes(name) && typeof adapter === 'function', 'invalid_domain_adapter');
  adapters.set(name, adapter);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
const effectsOf = (entry) => entry.effects ?? (entry.op.do ? [] : [entry.op]);
const idCount = (ids) => Object.values(ids ?? {}).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 1), 0);
// Entity writes an op costs the worker's 200-write commit cap; domain ops are estimated from their effects or new ids.
const writesOf = (entry) => entry.op.do ? Math.max(1, entry.effects?.length || 0, idCount(entry.op.args?.newIds)) : 1;
const stripServer = (entity) => Object.fromEntries(Object.entries(entity).filter(([key]) => !SERVER_FIELDS.includes(key) && key !== 't'));

function chainsOf(pending) {
  const chains = new Map();
  for (const entry of pending) {
    for (const effect of effectsOf(entry)) {
      const key = keyOf(effect.t, effect.id);
      if (!chains.has(key)) chains.set(key, []);
      chains.get(key).push({ entry, effect });
    }
  }
  return chains;
}

// Only effects from entries in `strict` throw; older pending work that no longer applies is skipped.
function computeEntity(state, key, chain, kind, uid, strict) {
  let entity = state.confirmed[key] ? structuredClone(state.confirmed[key]) : undefined;
  for (const { entry, effect } of chain) {
    const checked = strict?.has(entry);
    if (effect.put) {
      if (checked) invariant(!entity, 'already_exists', 409);
      entity = { ...structuredClone(effect.put), id: effect.id, v: entry.localVersion, rev: 0, upd: entry.at, by: uid, cr: entry.at };
    } else if (effect.del) entity = entity && { id: effect.id, deleted: true };
    else if (entity && !entity.deleted) {
      try { entity = applyPatch(kind, effect.t, entity, effect); } catch (error) { if (checked) throw error; }
    } else if (checked) invariant(false, 'gone', 409);
  }
  return entity;
}

function buildView(previous, state, kind, uid) {
  const chains = chainsOf(state.pending);
  const parked = new Map();
  for (const conflict of state.conflicts) for (const effect of effectsOf(conflict)) parked.set(keyOf(effect.t, effect.id), conflict.code);
  const keys = new Set([...Object.keys(state.confirmed), ...chains.keys()]);
  const entities = new Map();
  const signatures = new Map();
  const changed = new Set();
  for (const key of keys) {
    const chain = chains.get(key);
    const confirmed = state.confirmed[key];
    const signature = `${confirmed?.v ?? ''}${confirmed?.deleted ? '!' : ''}|${chain ? chain.map(({ entry }) => entry.localVersion).join(',') : ''}`;
    signatures.set(key, signature);
    if (previous?.signatures.get(key) === signature) {
      if (previous.entities.has(key)) entities.set(key, previous.entities.get(key));
      continue;
    }
    // Confirmed records are never changed in place (updates copy them), so they are frozen and shared, not cloned.
    const entity = chain ? computeEntity(state, key, chain, kind, uid) : confirmed;
    if (entity && !entity.deleted) entities.set(key, deepFreeze(entity));
    changed.add(key);
  }
  if (previous) for (const key of previous.signatures.keys()) if (!keys.has(key)) changed.add(key);
  const types = new Set([...changed].map(typeOf));
  const byType = new Map(previous?.byType ?? []);
  for (const type of types) byType.delete(type);
  return { entities, signatures, changed, types, byType, chains, parked };
}

export async function openSpaceStore({ ref, db, uid = db.account, api, now = Date.now, leaseMs = 35_000, makeId = newId, feed = true }) {
  validateSpaceRef(ref);
  invariant(uid === db.account, 'account_changed', 401);
  const key = `space:${ref.w}:${ref.s}`;
  const session = makeId();
  const clock = createClock({ node: session, now });
  const listeners = new Set();
  let state = (await db.get(key)) ?? empty();
  let reread = Boolean(state.skipped?.length);
  let view = buildView(null, state, ref.k, uid);
  let inFlight;
  let closed = false;
  // A 429 holds sends (not polls) for its `retryAfter`; the batch stays frozen and queued, and other tabs see the hold on it.
  let holdUntil = 0;

  function setState(next, extra = {}) {
    state = next;
    view = buildView(view, state, ref.k, uid);
    if (closed) return;
    const event = { changed: view.changed, types: view.types, rev: state.rev, ...extra };
    for (const listener of listeners) listener(event);
  }
  async function change(update, { drain = false, extra } = {}) {
    invariant(!closed || drain, 'store_closed');
    const next = await db.update(key, (current) => update(current ?? empty()));
    setState(next, extra);
    return next;
  }

  function acceptEntity(current, type, entity) {
    entitySchema(ref.k, type);
    if (entity.deleted && Object.hasOwn(entity, 't')) validateTombstone(entity);
    else validateEntity(ref.k, type, entity, { server: true });
    const id = keyOf(type, entity.id);
    const previous = current.confirmed[id];
    if (!previous || compareHlc(entity.v, previous.v) >= 0) current.confirmed[id] = structuredClone(entity);
  }
  function acceptServer(current, server) {
    if (!server || typeof server.t !== 'string') return undefined;
    try {
      const { t, ...data } = server;
      acceptEntity(current, t, server.deleted ? { ...data, t } : data);
      return structuredClone(server);
    } catch { return undefined; }
  }
  function expand(op) {
    if (!op.do) return undefined;
    const adapter = adapters.get(op.do);
    if (!adapter) return [];
    const effects = adapter(structuredClone(op.args), { get: (type, id) => view.entities.get(keyOf(type, id)), entities: (type) => store.entities(type), uid, now });
    invariant(Array.isArray(effects) && effects.length <= LIMITS.commitWrites, 'invalid_domain_adapter');
    return effects.map((effect) => {
      const checked = structuredClone(effect);
      validateOperation({ ...checked, opId: op.opId }, { kind: ref.k });
      return checked;
    });
  }
  function localCopy(op) {
    const entity = op.do ? undefined : view.entities.get(keyOf(op.t, op.id));
    return entity ? structuredClone(entity) : undefined;
  }
  function enqueue(current, ops) {
    const existing = new Set([...current.pending.map(({ op }) => op.opId), ...current.conflicts.map(({ op }) => op.opId)]);
    invariant(ops.every((op) => !existing.has(op.opId)), 'duplicate_op');
    const next = structuredClone(current);
    const added = new Set();
    for (const op of ops) {
      const entry = { op: structuredClone(op), at: now(), localVersion: clock.tick() };
      // The server version this op was made against, so a later own acknowledgement can rebase it.
      if (!op.do) entry.prev = next.confirmed[keyOf(op.t, op.id)]?.v ?? null;
      const effects = expand(op);
      if (effects) entry.effects = effects;
      next.pending.push(entry); added.add(entry);
    }
    const chains = chainsOf(next.pending);
    for (const entry of added) {
      for (const effect of effectsOf(entry)) {
        const entity = computeEntity(next, keyOf(effect.t, effect.id), chains.get(keyOf(effect.t, effect.id)), ref.k, uid, added);
        // What a patch looked like locally, so "keep mine" can restore it after a pull removed the entity.
        if (!entry.op.do && !entry.op.put && !entry.op.del && entity && !entity.deleted) entry.local = entity;
      }
    }
    return next;
  }

  const store = {
    ref,
    get rev() { return state.rev; },
    get pending() { return structuredClone(state.pending.map(({ op }) => op)); },
    get conflicts() { return structuredClone(state.conflicts); },
    get batch() { return structuredClone(state.batch); },
    /** Revs whose records or entities this build could not validate; reset by the next `replace`. */
    get skipped() { return [...(state.skipped ?? [])]; },
    /** True while skips recorded before this store opened (perhaps by an older build) wait for a `replace`. */
    get reread() { return reread; },
    entities(type) {
      if (!view.byType.has(type)) {
        const prefix = `${type}:`;
        view.byType.set(type, Object.freeze([...view.entities].filter(([id]) => id.startsWith(prefix)).map(([, entity]) => entity)));
      }
      return view.byType.get(type);
    },
    get(type, id) { return view.entities.get(keyOf(type, id)); },
    /** The last server version, for `base` on conflict-checked patches and deletes; undefined for local creates. */
    serverVersion(type, id) { const entity = state.confirmed[keyOf(type, id)]; return entity && !entity.deleted ? entity.v : undefined; },
    /** Overlay state for one entity: queued local work and any parked conflict code. */
    overlay(type, id) {
      const chain = view.chains.get(keyOf(type, id));
      return { pending: Boolean(chain), local: Boolean(chain && !state.confirmed[keyOf(type, id)]), conflict: view.parked.get(keyOf(type, id)) ?? null };
    },
    /** Listeners get `{changed: Set<'type:id'>, types: Set<type>, rev, feed?}`. */
    subscribe(listener) { invariant(!closed, 'store_closed'); listeners.add(listener); return () => listeners.delete(listener); },
    async refresh() {
      invariant(!closed, 'store_closed');
      const next = (await db.get(key)) ?? empty();
      if (!closed) setState(next);
    },
    async apply(ops) {
      validateCommit(ops, { kind: ref.k });
      await change((current) => enqueue(current, ops));
    },
    async receive(changes) {
      invariant(Array.isArray(changes), 'invalid_changes');
      const entries = [];
      await change((current) => {
        const next = structuredClone(current);
        entries.length = 0;
        for (const record of changes) {
          invariant(Number.isSafeInteger(record.rev) && record.rev > 0 && Array.isArray(record.ents) && Array.isArray(record.del), 'invalid_change_record');
          if (record.rev <= next.rev) continue;
          invariant(record.rev === next.rev + 1, 'sync_gap', 409);
          // A record this build cannot validate (usually from a newer release) is skipped whole but still advances rev.
          try {
            const checked = { confirmed: {} };
            for (const entity of record.ents) {
              invariant(typeof entity?.t === 'string', 'missing_entity_type');
              const { t, ...data } = entity;
              acceptEntity(checked, t, data);
            }
            for (const tombstone of record.del) acceptEntity(checked, tombstone.t, { ...tombstone, deleted: true, rev: record.rev });
          } catch {
            next.skipped = withSkipped(next.skipped, record.rev);
            next.rev = record.rev;
            continue;
          }
          const entry = feed && feedEntry(record, (id) => next.confirmed[id]);
          if (entry) entries.push(entry);
          for (const entity of record.ents) {
            const { t, ...data } = entity;
            acceptEntity(next, t, data);
          }
          for (const tombstone of record.del) acceptEntity(next, tombstone.t, { ...tombstone, deleted: true, rev: record.rev });
          next.rev = record.rev;
        }
        return next;
      });
      if (entries.length) {
        await appendFeed(db, ref, entries, now);
        if (!closed) for (const listener of listeners) listener({ changed: new Set(), types: new Set(), rev: state.rev, feed: true });
      }
    },
    /** Entities this build cannot validate are skipped and recorded; pass `invalid: true` when the caller already dropped some. */
    async replace(snapshot, { invalid = false } = {}) {
      invariant(Number.isSafeInteger(snapshot.rev) && snapshot.rev >= 0 && Array.isArray(snapshot.ents), 'invalid_snapshot');
      await change((current) => {
        invariant(snapshot.rev >= current.rev, 'stale_snapshot', 409);
        const next = { ...structuredClone(current), confirmed: Object.fromEntries(Object.entries(current.confirmed)
          .filter(([, entity]) => entity.rev > snapshot.rev)), rev: snapshot.rev, skipped: invalid ? [snapshot.rev] : [] };
        const accept = (type, value) => {
          try { acceptEntity(next, type, value); } catch { next.skipped = withSkipped(next.skipped, snapshot.rev); }
        };
        for (const entity of snapshot.ents) {
          const { t, ...data } = entity ?? {};
          if (next.confirmed[keyOf(t, data.id)]?.rev > snapshot.rev) continue;
          accept(t, data);
        }
        for (const tombstone of snapshot.tombstones ?? []) {
          if (next.confirmed[keyOf(tombstone?.t, tombstone?.id)]?.rev > snapshot.rev) continue;
          accept(tombstone?.t, tombstone ?? {});
        }
        return next;
      });
      reread = false;
    },
    /** Adds entities and tombstones outside the change log (older chat pages, recent records) by version only; `lenient` skips and records invalid ones. */
    async merge(ents, tombstones = [], { lenient = false } = {}) {
      invariant(Array.isArray(ents) && Array.isArray(tombstones) && ents.length + tombstones.length <= LIMITS.commitWrites * 25, 'invalid_entities');
      await change((current) => {
        const next = structuredClone(current);
        const accept = (type, value) => {
          try { acceptEntity(next, type, value); } catch (error) {
            if (!lenient) throw error;
            next.skipped = withSkipped(next.skipped, Number.isSafeInteger(value?.rev) ? value.rev : next.rev);
          }
        };
        for (const entity of ents) {
          const { t, ...data } = entity;
          accept(t, data);
        }
        for (const tombstone of tombstones) accept(tombstone.t, tombstone);
        return next;
      });
    },
    feed() { return readFeed(db, ref); },
    flush() {
      invariant(!closed, 'store_closed');
      invariant(api, 'api_unavailable');
      if (inFlight) return inFlight;
      if (holdUntil > now()) return Promise.resolve({ status: 'queued', held: true });
      inFlight = (async () => {
        let claimed = false;
        let held = false;
        // Nothing to send, or a batch held elsewhere, leaves the record untouched: no copy and no write.
        const claimedState = await change((current) => {
          if (current.batch?.lease?.until > now() && current.batch.lease.owner !== session) return current;
          if (current.batch?.hold > now()) { held = true; return current; }
          if (!current.batch && !current.pending.length) return current;
          const next = structuredClone(current);
          if (!next.batch && next.pending.length) {
            const ops = [];
            const cap = Math.min(LIMITS.commitWrites, next.cap ?? LIMITS.commitWrites);
            let weight = 0;
            for (const entry of next.pending) {
              const writes = writesOf(entry);
              if (ops.length && weight + writes > cap) break;
              const candidate = [...ops, entry.op];
              if (new TextEncoder().encode(JSON.stringify({ op: 'commit', space: ref.s, ops: candidate })).length > LIMITS.bodyBytes) break;
              ops.push(entry.op); weight += writes;
            }
            invariant(ops.length > 0, 'operation_too_large', 413);
            next.batch = { id: makeId(), body: JSON.stringify({ op: 'commit', space: ref.s, ops }), opIds: ops.map((op) => op.opId), weight };
          }
          if (next.batch) {
            next.batch.lease = { owner: session, until: now() + leaseMs };
            claimed = true;
          }
          return next;
        });
        if (held) return { status: 'queued', held: true };
        if (!claimed) return { status: state.pending.length ? 'busy' : 'idle' };
        const frozen = structuredClone(claimedState.batch);
        const ownsBatch = (current) => current.batch?.id === frozen.id && current.batch.lease?.owner === session;
        if (closed) {
          await change((current) => {
            const next = structuredClone(current);
            if (ownsBatch(next)) next.batch.lease = null;
            return next;
          }, { drain: true });
          return { status: 'queued' };
        }
        try {
          const response = await api.commit(ref, frozen.body);
          invariant(response && Number.isSafeInteger(response.rev) && response.rev > 0 && response.done && typeof response.done === 'object'
            && Array.isArray(response.ents) && Array.isArray(response.del), 'invalid_commit_response', 502);
          invariant(frozen.opIds.every((id) => Number.isSafeInteger(response.done[id]) && response.done[id] > 0 && response.done[id] <= response.rev), 'invalid_commit_response', 502);
          try {
            const checked = { confirmed: {} };
            for (const entity of response.ents) {
              const { t, ...data } = entity;
              acceptEntity(checked, t, data);
            }
            for (const tombstone of response.del) acceptEntity(checked, tombstone.t, { ...tombstone, deleted: true, rev: response.rev });
          } catch { throw new DomainError('invalid_commit_response', 502); }
          await change((current) => {
            const next = structuredClone(current);
            // Versions our own acknowledged ops replaced, keyed `type:id|version`, mapped to the version they produced.
            const replaced = new Map();
            const produced = new Map(response.ents.map((entity) => [keyOf(entity.t, entity.id), entity.v]));
            for (const entity of response.ents) {
              const { t, ...data } = entity;
              const id = keyOf(t, data.id);
              if (next.confirmed[id]?.v && compareHlc(data.v, next.confirmed[id].v) > 0) replaced.set(`${id}|${next.confirmed[id].v}`, data.v);
              acceptEntity(next, t, data);
            }
            for (const tombstone of response.del) acceptEntity(next, tombstone.t, { ...tombstone, deleted: true, rev: response.rev });
            const acknowledged = new Set(frozen.opIds);
            for (const { op, prev } of next.pending) {
              const id = !op.do && acknowledged.has(op.opId) ? keyOf(op.t, op.id) : null;
              if (id && produced.has(id)) for (const old of [prev, op.base]) if (old) replaced.set(`${id}|${old}`, produced.get(id));
            }
            next.pending = next.pending.filter(({ op }) => !acknowledged.has(op.opId));
            // Queued edits made against a version only our own write replaced now base on its successor.
            for (const entry of next.pending) {
              if (entry.op.do) continue;
              const id = keyOf(entry.op.t, entry.op.id);
              if (entry.op.base && replaced.has(`${id}|${entry.op.base}`)) entry.op.base = replaced.get(`${id}|${entry.op.base}`);
              if (entry.prev && replaced.has(`${id}|${entry.prev}`)) entry.prev = replaced.get(`${id}|${entry.prev}`);
            }
            delete next.cap;
            if (next.batch?.id === frozen.id) next.batch = null;
            // Commit acknowledgements do not prove the intervening change log was read.
            return next;
          }, { drain: true });
          return { status: 'sent', rev: response.rev };
        } catch (error) {
          if (error.status === 429) holdUntil = now() + Math.min(Number.isFinite(error.retryAfter) && error.retryAfter > 0 ? error.retryAfter : 5, 3600) * 1000;
          let handled = false;
          let failedIds = [];
          const ids = new Set(frozen.opIds);
          // A batch-level 413 is split and resent rather than parked.
          const split = error.status === 413 && !error.op && frozen.opIds.length > 1;
          const parked = PARKED.has(error.status) && !split;
          const failed = parked && error.op && ids.has(error.op) ? new Set([error.op]) : ids;
          const locals = new Map([...failed].map((opId) => {
            const entry = state.pending.find(({ op }) => op.opId === opId);
            return [opId, localCopy(entry?.op ?? {}) ?? entry?.local];
          }));
          await change((current) => {
            const next = structuredClone(current);
            if (!ownsBatch(next)) return next;
            handled = true;
            if (parked) {
              const server = error.status === 409 ? acceptServer(next, error.server) : undefined;
              const entries = next.pending.filter(({ op }) => failed.has(op.opId));
              failedIds = entries.map(({ op }) => op.opId);
              if (error.status !== 403) {
                for (const entry of entries) next.conflicts.push({ ...entry, code: error.code ?? 'invalid', server, local: locals.get(entry.op.opId) });
              }
              next.pending = next.pending.filter(({ op }) => !failed.has(op.opId));
              next.batch = null;
            } else if (split) {
              next.cap = Math.max(1, Math.floor((frozen.weight ?? frozen.opIds.length) / 2));
              next.batch = null;
            } else {
              next.batch.lease = null;
              if (error.status === 429) next.batch.hold = holdUntil;
            }
            return next;
          }, { drain: true });
          if (!handled) return { status: state.pending.length ? 'busy' : 'idle' };
          if (split) return { status: 'queued', retry: true };
          if (!parked) return { status: 'queued', error };
          return { status: error.status === 403 ? 'rejected' : 'conflict', error, opIds: failedIds };
        }
      })().finally(() => { inFlight = undefined; });
      return inFlight;
    },
    /**
     * `keep: 'theirs'` drops the parked op; `'mine'` resends it against the server version (a copy under a new id when the
     * entity is gone or the id was taken); `'merge'` sends `set`/`unset` against the server version. Returns the new op or null.
     */
    async resolveConflict(opId, { keep, set, unset } = {}) {
      invariant(!closed, 'store_closed');
      invariant(['mine', 'theirs', 'merge'].includes(keep), 'invalid_resolution');
      let created = null;
      await change((current) => {
        const conflict = current.conflicts.find(({ op }) => op.opId === opId);
        invariant(conflict, 'conflict_not_found', 404);
        const next = { ...structuredClone(current), conflicts: current.conflicts.filter(({ op }) => op.opId !== opId) };
        if (keep === 'theirs') return next;
        const { op } = conflict;
        const server = conflict.server ?? (op.do ? undefined : current.confirmed[keyOf(op.t, op.id)]);
        const base = server && !server.deleted && Object.hasOwn(op, 'base') ? { base: server.v } : {};
        const gone = !op.do && (server?.deleted || conflict.code === 'gone' || conflict.code === 'already_exists');
        if (gone && op.del) return next;
        if (op.do) created = { opId: makeId(), do: op.do, args: structuredClone(op.args) };
        else if (keep === 'merge') {
          invariant(!gone && !op.put, 'merge_unavailable', 409);
          created = { opId: makeId(), t: op.t, id: op.id, ...(set && Object.keys(set).length ? { set } : {}), ...(unset?.length ? { unset } : {}), ...base };
        } else if (gone) {
          const fields = op.put ?? (conflict.local ? stripServer(conflict.local) : undefined);
          invariant(fields && !op.del, 'restore_unavailable', 409);
          created = { opId: makeId(), t: op.t, id: makeId(), put: structuredClone(fields) };
        } else created = { ...structuredClone(op), opId: makeId(), ...base };
        validateCommit([created], { kind: ref.k });
        return enqueue(next, [created]);
      });
      return created;
    },
    async discardConflict(opId) {
      await change((current) => ({ ...current, conflicts: current.conflicts.filter(({ op }) => op.opId !== opId) }));
    },
    close() { closed = true; listeners.clear(); },
  };
  return store;
}
