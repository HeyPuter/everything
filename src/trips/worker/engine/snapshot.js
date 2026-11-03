import { compareHlc, isHlc, parseHlc } from '../../src/shared/hlc.js';
import { LIMITS } from '../../src/shared/limits.js';
import { plainObject } from '../../src/shared/schema/dsl.js';
import { fail } from '../http.js';
import { K, P } from '../keys.js';
import { assemble, republish } from './log.js';
import { allMessages, recentMessages, scanEntities } from './scan.js';
import { pool } from './store.js';

const REBUILD_REVS = 200;
const REBUILD_AGE = 10 * 60_000;
const SNAP_META_TTL = 5000;
const MERGE_RECENT = 20;
const VERIFY_REVS = 2000;
// A record older than this belongs to a commit that has finished (or given up) writing its entities.
const SETTLED = 120_000;
const TOMBSTONE_TTL = 30 * 86_400_000;

const canonical = (value) => JSON.stringify(value, (_, item) => (plainObject(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1))) : item));

export async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

const newer = (a, b) => !b || (isHlc(a?.v) && isHlc(b.v) && compareHlc(a.v, b.v) > 0);

/** Snapshot state `{rev, at, bytes}` with a short isolate cache. */
export async function snapMeta(w, sid, { fresh = false } = {}) {
  const cached = w.snapMetas.get(sid);
  if (!fresh && cached && w.now() - cached.checked < SNAP_META_TTL) return cached.value;
  const value = await w.kv.get(K.snap(sid));
  w.snapMetas.set(sid, { value: value ?? null, checked: w.now() });
  return value ?? null;
}

export function needsRebuild(w, snap, rev) {
  if (!snap) return rev >= REBUILD_REVS;
  return rev - snap.rev >= REBUILD_REVS || (rev > snap.rev && w.now() - snap.at >= REBUILD_AGE);
}

/** Seconds until the next rebuild claim window, for a `snapshot_pending` answer. */
export const rebuildWait = (w) => Math.max(2, Math.ceil((120_000 - (w.now() % 120_000)) / 1000));

/** Claims the 120 s window; the window number in the key means a lost expire never blocks rebuilds. */
async function claimRebuild(w, sid) {
  const key = K.snapclaim(sid, w.now());
  const count = await w.kv.incr(key);
  if (count === 1) await w.kv.expire(key, 240).catch(() => {});
  return count === 1;
}

/** Assembled change records for revs `first..last`; missing or partial ones are left out. */
async function readRecords(w, sid, first, last) {
  const records = new Map();
  if (last < first) return records;
  const heads = await w.kv.getMany(Array.from({ length: last - first + 1 }, (_, i) => K.ch(sid, first + i, 0)));
  const extraKeys = heads.flatMap((head) => (head?.parts > 1 ? Array.from({ length: head.parts - 1 }, (_, n) => K.ch(sid, head.rev, n + 1)) : []));
  const extras = new Map();
  if (extraKeys.length) (await w.kv.getMany(extraKeys)).forEach((value, i) => extras.set(extraKeys[i], value));
  heads.forEach((head, i) => {
    if (head?.rev !== first + i) return;
    const record = assemble([head, ...Array.from({ length: Math.max(0, (head.parts ?? 1) - 1) }, (_, n) => extras.get(K.ch(sid, head.rev, n + 1)))]);
    if (record) records.set(record.rev, record);
  });
  return records;
}

/**
 * Entities whose change records misstate KV: the record at the entity's `rev` lacks or differs from it
 * (another region overwrote the record, or concurrent patches merged in KV), or a settled record wrote
 * an entity that KV no longer reflects. Clients would never repair these on their own, because no rev is missing.
 */
function misstated(stored, records, floor, now) {
  const indexes = new Map();
  const indexOf = (record) => {
    if (!indexes.has(record.rev)) {
      const index = new Map();
      for (const entity of record.ents) index.set(`${entity.t}:${entity.id}`, entity);
      for (const gone of record.del) index.set(`${gone.t}:${gone.id}`, { ...gone, deleted: true });
      indexes.set(record.rev, index);
    }
    return indexes.get(record.rev);
  };
  const out = new Map();
  for (const [tid, value] of stored) {
    if (!(value.rev > floor)) continue;
    const record = records.get(value.rev);
    if (!record) continue;
    const said = indexOf(record).get(tid);
    const t = tid.slice(0, tid.indexOf(':'));
    const same = said && (value.deleted ? said.deleted && said.v === value.v : !said.deleted && canonical({ ...said, t }) === canonical({ ...value, t }));
    if (!same) out.set(tid, value);
  }
  for (const record of records.values()) {
    if (!(record.rev > floor) || !(now - record.at > SETTLED)) continue;
    for (const tid of indexOf(record).keys()) {
      const value = stored.get(tid);
      if (value && !(value.rev >= record.rev)) out.set(tid, value);
    }
  }
  return [...out].map(([tid, value]) => ({ t: tid.slice(0, tid.indexOf(':')), id: tid.slice(tid.indexOf(':') + 1), value }));
}

/** Full scan of entities plus recent (or all) messages. A full scan is authoritative. */
export async function collect(w, sid, kind, { everyMessage = false, verify = false } = {}) {
  const startRev = (await w.kv.get(K.rev(sid))) ?? 0;
  const scanned = await scanEntities(w, sid);
  const messages = everyMessage ? await allMessages(w, sid) : await recentMessages(w, sid, 200);
  const byKey = new Map();
  const stored = new Map();
  for (const { key, value } of scanned.items) {
    const [, , , t, id] = key.split(':');
    if (!t || !id || !value || typeof value !== 'object') continue;
    stored.set(`${t}:${id}`, value);
    byKey.set(`${t}:${id}`, value.deleted ? { id: value.id ?? id, t, deleted: true, rev: value.rev ?? 0, v: value.v } : { t, ...value });
  }
  for (const { value } of messages.items) if (value && typeof value === 'object' && typeof value.id === 'string') stored.set(`msg:${value.id}`, value);
  // Records since the last snapshot are checked against KV; the last few also cover commits still writing.
  const floor = verify ? Math.max((await snapMeta(w, sid))?.rev ?? 0, startRev - VERIFY_REVS) : startRev;
  const records = await readRecords(w, sid, Math.max(1, Math.min(floor, startRev - MERGE_RECENT) + 1), startRev);
  const stale = verify ? misstated(stored, records, floor, w.now()) : [];
  for (const record of records.values()) {
    if (record.rev <= startRev - MERGE_RECENT) continue;
    for (const entity of record.ents) if (entity.t !== 'msg' && newer(entity, byKey.get(`${entity.t}:${entity.id}`))) byKey.set(`${entity.t}:${entity.id}`, entity);
    for (const gone of record.del) {
      const held = byKey.get(`${gone.t}:${gone.id}`);
      if (newer(gone, held)) byKey.set(`${gone.t}:${gone.id}`, { id: gone.id, t: gone.t, deleted: true, rev: record.rev, v: gone.v });
    }
  }
  const now = w.now();
  const ents = [];
  const tombstones = [];
  const expired = [];
  const counts = { e: 0, day: 0, place: 0, collab: 0, bytes: 0, members: 0 };
  for (const value of byKey.values()) {
    if (value.deleted) {
      if (isHlc(value.v) && now - parseHlc(value.v).time > TOMBSTONE_TTL) expired.push(value);
      else tombstones.push({ id: value.id, t: value.t, deleted: true, rev: value.rev, v: value.v });
      continue;
    }
    ents.push(value);
    if (!['meta', 'member', 'file'].includes(value.t)) counts.e++;
    if (value.t === 'day' || value.t === 'place') counts[value.t]++;
    if (value.t === 'note' || value.t === 'link' || value.t === 'poll') counts.collab++;
    if (value.t === 'file') counts.bytes += Number(value.size) || 0;
    if (value.t === 'member') counts.members++;
  }
  for (const { value } of messages.items) if (value && typeof value === 'object') ents.push({ t: 'msg', ...value });
  const live = stale.filter(({ value }) => !(value.deleted && isHlc(value.v) && now - parseHlc(value.v).time > TOMBSTONE_TTL));
  return { snapshot: { rev: startRev, at: now, kind, ents, tombstones }, counts, expired, stale: live, complete: scanned.complete && messages.complete !== false };
}

/** Full scan into `snapshot.json.gz`. Returns the new snap state, or null when another rebuild holds the window. */
export async function rebuild(w, sid, kind, { force = false } = {}) {
  if (!force && !(await claimRebuild(w, sid))) return null;
  const { snapshot, counts, expired, stale, complete } = await collect(w, sid, kind, { verify: true });
  // A partial scan would make clients drop entities on replace.
  if (!complete) fail('snapshot_incomplete', 503);
  const { rev: startRev, at: now } = snapshot;
  const bytes = await gzip(JSON.stringify(snapshot));
  await w.fs.write(P.snapshot(sid), new Blob([bytes], { type: 'application/gzip' }), { overwrite: true, createMissingParents: true, dedupeName: false });
  const meta = { rev: startRev, at: now, bytes: bytes.byteLength };
  await w.kv.set(K.snap(sid), meta);
  w.snapMetas.set(sid, { value: meta, checked: now });
  w.snapshots.set(sid, { meta, bytes });
  // Self-heal the cap counters when no commit ran during the scan.
  if ((await w.kv.get(K.rev(sid))) === startRev) await w.kv.set(K.count(sid), counts);
  if (expired.length) await pool(expired.slice(0, 200), 4, (value) => w.kv.del(K.entity(sid, value.t, value.id)));
  // The snapshot already holds the KV state; a fresh record brings path C and path A clients to it too.
  if (stale.length) await republish(w, sid, (await w.owner()).uuid, stale.slice(0, LIMITS.commitWrites)).catch(() => {});
  return meta;
}

/**
 * The current snapshot bytes, rebuilding inline when none exists yet and in the background when stale. A snapshot
 * older than `clean` (the last scrub's rev) may hold deleted content, so it is rebuilt first, or null while another
 * rebuild holds the window.
 */
export async function snapshotBytes(w, sid, kind, { rev, clean } = {}) {
  let meta = await snapMeta(w, sid);
  if (meta && Number.isSafeInteger(clean) && meta.rev < clean) meta = (await snapMeta(w, sid, { fresh: true })) ?? meta;
  if (!meta || (Number.isSafeInteger(clean) && meta.rev < clean)) meta = await rebuild(w, sid, kind);
  if (!meta) return null;
  const cached = w.snapshots.get(sid);
  let bytes = cached && cached.meta.rev === meta.rev && cached.meta.at === meta.at ? cached.bytes : null;
  if (!bytes) {
    try { bytes = new Uint8Array(await (await w.fs.read(P.snapshot(sid))).arrayBuffer()); } catch (error) {
      if (error?.status !== 404 && error?.code !== 'subject_does_not_exist') throw error;
      meta = await rebuild(w, sid, kind);
      return meta ? { meta, bytes: w.snapshots.get(sid).bytes } : null;
    }
    w.snapshots.set(sid, { meta, bytes });
  }
  if (rev !== undefined && needsRebuild(w, meta, rev)) w.waitUntil(rebuild(w, sid, kind).catch(() => {}));
  return { meta, bytes };
}

export async function snapshotJson(w, sid, kind, options = {}) {
  const found = await snapshotBytes(w, sid, kind, options);
  if (!found) return null;
  const cached = w.parsed.get(sid);
  if (cached && cached.at === found.meta.at && cached.rev === found.meta.rev) return cached.value;
  const value = JSON.parse(await gunzip(found.bytes));
  w.parsed.set(sid, { at: found.meta.at, rev: found.meta.rev, value, weight: found.bytes.byteLength * 10 });
  return value;
}

