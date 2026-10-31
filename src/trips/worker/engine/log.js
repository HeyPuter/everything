import { LIMITS, TIMING } from '../../src/shared/limits.js';
import { fail } from '../http.js';
import { K, byteLength } from '../keys.js';
import { absorb, noteRev } from './space.js';
import { plainPath, pool } from './store.js';

const CLAIM_ATTEMPTS = 32;
const SIG_BYTES = LIMITS.eventBytes - 512;

const nameOf = (t, entity) => {
  const value = entity?.title ?? entity?.name ?? entity?.question ?? (t === 'msg' ? entity?.text : undefined);
  return typeof value === 'string' ? value.slice(0, 80) : '';
};

/** Splits a change record into chunks of ≤100 KB; a single oversized entity gets a chunk of its own. */
export function buildChunks({ rev, at, by, ents, del, sum }) {
  const parts = [];
  let current = { ents: [], del: [] };
  let size = byteLength(sum) + 200;
  const push = (list, item) => {
    const weight = byteLength(item) + 1;
    if ((current.ents.length || current.del.length) && size + weight > LIMITS.changeBytes) {
      parts.push(current);
      current = { ents: [], del: [] };
      size = 200;
    }
    current[list].push(item);
    size += weight;
  };
  for (const entity of ents) push('ents', entity);
  for (const tombstone of del) push('del', tombstone);
  parts.push(current);
  return parts.map((part, index) => (index === 0
    ? { rev, parts: parts.length, at, by, ents: part.ents, del: part.del, sum }
    : { rev, at, by, ents: part.ents, del: part.del }));
}

/** Joins chunk values into one record, or null when any part is missing. */
export function assemble(chunks) {
  const [first] = chunks;
  if (!first || !Number.isSafeInteger(first.parts) || chunks.length !== first.parts || chunks.some((chunk) => !chunk)) return null;
  return {
    rev: first.rev, at: first.at, by: first.by,
    ents: chunks.flatMap((chunk) => chunk.ents ?? []),
    del: chunks.flatMap((chunk) => chunk.del ?? []),
    sum: first.sum ?? [],
  };
}

// Every chunk must fit one KV item with room for the wrapper.
const ITEM_BYTES = LIMITS.kvBytes - 1024;

/** A claimed rev must never stay a hole, so a failed chunk-0 write leaves an empty record behind. */
async function fill(w, sid, rev, at, by, expireAt) {
  try { await w.kv.setIfAbsent(K.ch(sid, rev, 0), { rev, parts: 1, at, by, ents: [], del: [], sum: [] }, { expireAt }); }
  catch { /* the snapshot rebuild covers a hole the filler could not close */ }
}

/**
 * `incr` hands out unique revs within one region; chunk 0 written with `onlyIfAbsent` is the claim, so a rev another
 * region already wrote and replicated is skipped. The platform checks per region, so two regions claiming the same rev
 * before replication both succeed and the later record wins; the next snapshot rebuild re-announces what it lost.
 */
async function claim(w, sid, compose, at, by) {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const rev = await w.kv.incr(K.rev(sid));
    if (!Number.isSafeInteger(rev) || rev < 1) fail('internal', 500);
    const chunks = compose(rev);
    const expireAt = w.now() + TIMING.changeRetention;
    let claimed;
    try { claimed = await w.kv.setIfAbsent(K.ch(sid, rev, 0), chunks[0], { expireAt }); } catch (error) {
      await fill(w, sid, rev, at, by, expireAt);
      throw error;
    }
    if (claimed !== false) return { rev, chunks };
  }
  return fail('busy', 503);
}

/**
 * Re-announces KV entities (`{t, id, value}`) whose change records misstated them, under a fresh
 * version so every replica takes the KV state. Only `v` and `rev` change in KV.
 */
export function republish(w, sid, actor, items) {
  const writes = items.map(({ t, id, value }) => {
    const key = K.entity(sid, t, id);
    const v = w.clock.tick(value.v);
    if (value.deleted) return { t, id, key, mode: 'del', entity: { id, t, deleted: true, rev: 0, v }, before: null, fields: [] };
    const { t: _t, ...rest } = value;
    return { t, id, key, mode: 'patch', entity: { ...rest, v }, set: {}, unset: [], before: rest, fields: [] };
  });
  return persist(w, sid, actor, { writes });
}

/**
 * Claims a rev and writes one change. `writes` hold stamped entities whose `rev` is filled in here:
 * `{t, id, key, mode: 'put'|'patch'|'full'|'del', entity, set?, unset?, before?}`.
 * `extra` items are written with the entities; `after` items with the op ids, before the signal.
 */
export async function persist(w, sid, actor, { writes, extra = [], after = [], deltas = {} }) {
  const at = w.now();
  const ents = [];
  const del = [];
  const sum = [];
  const compose = (rev) => {
    ents.length = 0; del.length = 0; sum.length = 0;
    for (const write of writes) {
      write.entity.rev = rev;
      if (write.mode === 'del') del.push({ t: write.t, id: write.id, v: write.entity.v });
      else ents.push({ t: write.t, ...write.entity });
      sum.push({
        t: write.t, id: write.id, op: write.created ? 'put' : write.mode === 'del' ? 'del' : 'set',
        name: nameOf(write.t, write.mode === 'del' ? write.before : write.entity),
        fields: write.fields ?? [],
        // The record that held the previous version, so a later delete can find and scrub every one.
        ...(previous(write) ? { prev: previous(write) } : {}),
      });
    }
    return buildChunks({ rev, at, by: actor, ents, del, sum });
  };
  // Refuse before claiming a rev when any chunk could not be stored.
  if (compose(Number.MAX_SAFE_INTEGER).some((chunk) => byteLength(chunk) > ITEM_BYTES)) fail('entity_too_large', 413);
  const { rev, chunks } = await claim(w, sid, compose, at, actor);
  const expireAt = at + TIMING.changeRetention;
  const sets = [...extra];
  const patches = [];
  for (const write of writes) {
    if (write.mode === 'patch' && [...Object.keys(write.set ?? {}), ...(write.unset ?? [])].every(plainPath)) patches.push(write);
    else {
      const { entity } = write;
      sets.push({ key: write.key, value: write.mode === 'del' ? { id: entity.id, t: write.t, deleted: true, rev, v: entity.v } : entity });
    }
  }
  for (let n = 1; n < chunks.length; n++) sets.push({ key: K.ch(sid, rev, n), value: chunks[n], expireAt });
  const counted = Object.fromEntries(Object.entries(deltas).filter(([, value]) => value));
  const writeAll = () => Promise.all([
    w.kv.setMany(sets),
    pool(patches, 8, async (write) => {
      const { entity } = write;
      await w.kv.update(write.key, { ...write.set, v: entity.v, rev, upd: entity.upd, by: entity.by });
      if (write.unset?.length) await w.kv.remove(write.key, write.unset);
    }),
  ]);
  const counting = Object.keys(counted).length ? w.kv.incrPaths(K.count(sid), counted).catch(() => {}) : null;
  const done = after.map((item) => (typeof item.value === 'function' ? { ...item, value: item.value(rev) } : item));
  // The record already claims these writes (they are idempotent): retry once inline, then once more after failing the request.
  try { await writeAll(); } catch {
    try { await writeAll(); } catch (error) {
      w.waitUntil((async () => { await writeAll(); await w.kv.setMany(done); })().catch(() => {}));
      throw error;
    }
  }
  await counting;
  await w.kv.setMany(done);
  const record = assemble(chunks);
  await w.kv.set(K.sig(sid), byteLength(record) <= SIG_BYTES ? record : { rev });
  noteRev(w, sid, rev);
  // Heads read the cached meta next to the rev just noted, so keep the two in step.
  for (const write of writes) if (write.t === 'meta' && write.id === 'meta') absorb(w, sid, write.key, write.mode === 'del' ? null : write.entity);
  const targets = scrubTargets(writes);
  if (targets.length) {
    await w.kv.set(K.scrub(sid), rev).catch(() => {});
    await scrub(w, sid, targets).catch(() => {});
  }
  return { rev, ents, del, record };
}

const previous = (write) => (Number.isSafeInteger(write.before?.rev) && write.before.rev > 0 ? write.before.rev : 0);

/** Deletes, message soft deletes and message edits leave earlier versions to scrub: `[{t, id, rev}]`. */
function scrubTargets(writes) {
  return writes.filter((write) => previous(write) && (write.mode === 'del' || (write.t === 'msg' && (write.entity.deleted === true || write.fields?.includes('text')))))
    .map((write) => ({ t: write.t, id: write.id, rev: previous(write) }));
}

const SCRUB_DEPTH = 64;

/**
 * Removes earlier versions of entities from the change records that carried them (members who join later can read
 * old records through their handle or `sync`) and blanks their names in `sum`. Each `sum` entry names the record
 * that held the version before it (`prev`), so the walk reads only those records. Records without `prev` end it.
 */
export async function scrub(w, sid, targets) {
  let frontier = new Map();
  const add = (map, rev, tid) => { if (!map.has(rev)) map.set(rev, new Set()); map.get(rev).add(tid); };
  for (const { t, id, rev } of targets) add(frontier, rev, `${t}:${id}`);
  for (let depth = 0; depth < SCRUB_DEPTH && frontier.size; depth++) {
    const revs = [...frontier.keys()];
    const heads = await w.kv.getMany(revs.map((rev) => K.ch(sid, rev, 0)));
    const extraKeys = heads.flatMap((head, i) => (head?.rev === revs[i] && head.parts > 1 ? Array.from({ length: head.parts - 1 }, (_, n) => K.ch(sid, head.rev, n + 1)) : []));
    const extras = new Map();
    if (extraKeys.length) (await w.kv.getMany(extraKeys)).forEach((value, i) => extras.set(extraKeys[i], value));
    const next = new Map();
    const sets = [];
    heads.forEach((head, i) => {
      const rev = revs[i];
      if (head?.rev !== rev) return;
      const tids = frontier.get(rev);
      const expireAt = (Number(head.at) || w.now()) + TIMING.changeRetention;
      const chunks = [head, ...Array.from({ length: Math.max(0, (head.parts ?? 1) - 1) }, (_, n) => extras.get(K.ch(sid, rev, n + 1)))];
      chunks.forEach((chunk, n) => {
        if (chunk?.rev !== rev) return;
        const ents = (chunk.ents ?? []).filter((entity) => !tids.has(`${entity.t}:${entity.id}`));
        let named = false;
        const sum = n === 0 && Array.isArray(chunk.sum) ? chunk.sum.map((entry) => {
          if (!tids.has(`${entry?.t}:${entry?.id}`)) return entry;
          if (Number.isSafeInteger(entry.prev) && entry.prev < rev) add(next, entry.prev, `${entry.t}:${entry.id}`);
          if (!entry.name) return entry;
          named = true;
          return { ...entry, name: '' };
        }) : chunk.sum;
        if (ents.length !== (chunk.ents ?? []).length || named) sets.push({ key: K.ch(sid, rev, n), value: { ...chunk, ents, ...(n === 0 ? { sum } : {}) }, expireAt });
      });
      w.records.delete(`${sid}:${rev}`);
    });
    if (sets.length) await w.kv.setMany(sets);
    frontier = next;
  }
}
