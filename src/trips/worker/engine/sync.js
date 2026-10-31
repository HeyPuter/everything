import { isId } from '../../src/shared/ids.js';
import { PROTOCOL } from '../../src/shared/protocol.js';
import { bytesResponse, check, fail } from '../http.js';
import { K, byteLength, own, spaceId } from '../keys.js';
import { assemble } from './log.js';
import { ensureAccess, filesInfo } from './members.js';
import { maintain } from './files.js';
import { sweepSoon } from './inbox.js';
import { DAY, meter, metered, throttle } from './limits.js';
import { recentMessages } from './scan.js';
import { needsRebuild, rebuild, rebuildWait, snapshotBytes } from './snapshot.js';
import { absorb, kindOf, loadMember, loadRecords, recordOf, roleOf, setMember, staleKeys, titleOf } from './space.js';

const RETAINED = 2000;
const PER_SYNC = 500;
const SYNC_BYTES = 4 * 1024 * 1024;
const PRESENCE_WRITE = 120_000;
const PRESENCE_ACTIVE = 300_000;
const RENEW_WINDOW = 10 * 60_000;
// Records cached in the isolate (only ones older than SETTLED, whose commit finished writing) live this long.
const RECORD_TTL = 60_000;
const SETTLED = 120_000;
// Path C reads the owner pays for, per member and space (architecture §6).
export const READ_BUDGET = Object.freeze({ windowMs: DAY, limit: 128 * 1024 ** 2, floor: 256 * 1024 });
export const SNAPSHOT_BUDGET = Object.freeze({ windowMs: DAY, limit: 256 * 1024 ** 2, floor: 256 * 1024 });
// A longer catch-up is a reload or a lost client; the snapshot answers it when it covers the gap.
const LONG_CATCHUP = 50;

const sinceOf = (value) => { check(Number.isSafeInteger(value) && value >= 0, 'invalid_since'); return value; };

async function member(w, ident, input, options = {}) {
  const sid = spaceId(input.space);
  return { sid, ...(await loadMember(w, ident, sid, options)) };
}

function cachedRecord(w, sid, rev) {
  const hit = w.records.get(`${sid}:${rev}`);
  return hit && w.now() - hit.at < RECORD_TTL ? hit : null;
}

/** `{since}` → the contiguous run of change records after `since`, or `{reset:true}`. */
export async function sync(w, ident, input) {
  const since = sinceOf(input.since);
  const { sid, s } = await member(w, ident, input, { rev: true });
  throttle(w, `sync:${sid}:${ident.uuid}`, 120, 60_000);
  const rev = s.rev ?? 0;
  if (since >= rev) return { rev: Math.max(rev, since), changes: [] };
  if (rev - since > RETAINED) return { rev, reset: true };
  if (rev - since > LONG_CATCHUP) {
    const known = w.snapMetas.get(sid)?.value;
    if (known && known.rev - since > LONG_CATCHUP) return { rev, reset: true };
    throttle(w, `synclong:${sid}:${ident.uuid}`, 1, 60_000);
  }
  metered(w, sid, 'rdb', ident.uuid, READ_BUDGET);
  const target = Math.min(rev, since + PER_SYNC);
  const changes = [];
  let size = 0;
  let read = 0;
  let next = since + 1;
  let snap;
  let stopped = false;
  let capped = false;
  while (!stopped && next <= target) {
    const end = Math.min(target, next + 99);
    const revs = Array.from({ length: end - next + 1 }, (_, i) => next + i);
    const hits = new Map(revs.map((r) => [r, cachedRecord(w, sid, r)]).filter(([, hit]) => hit));
    const misses = revs.filter((r) => !hits.has(r));
    const keys = misses.map((r) => K.ch(sid, r, 0));
    const first = snap === undefined && misses.length > 0;
    if (first) keys.push(K.snap(sid));
    const values = keys.length ? await w.kv.getMany(keys) : [];
    if (first) {
      snap = values.pop() ?? null;
      w.snapMetas.set(sid, { value: snap, checked: w.now() });
    }
    read += values.reduce((sum, value) => sum + (value ? byteLength(value) : 0), 0);
    const fetched = new Map(misses.map((r, i) => [r, values[i]]));
    const heads = [];
    for (const r of revs) {
      const head = hits.get(r)?.record ?? fetched.get(r);
      if (!head || head.rev !== r) break;
      heads.push(head);
    }
    if (heads.length < revs.length) stopped = true;
    const extraKeys = heads.flatMap((head) => (!hits.has(head.rev) && head.parts > 1 ? Array.from({ length: head.parts - 1 }, (_, n) => K.ch(sid, head.rev, n + 1)) : []));
    const extras = new Map();
    if (extraKeys.length) {
      (await w.kv.getMany(extraKeys)).forEach((value, i) => { extras.set(extraKeys[i], value); read += value ? byteLength(value) : 0; });
    }
    for (const head of heads) {
      const hit = hits.get(head.rev);
      const record = hit ? hit.record : assemble([head, ...Array.from({ length: Math.max(0, (head.parts ?? 1) - 1) }, (_, n) => extras.get(K.ch(sid, head.rev, n + 1)))]);
      if (!record) { stopped = true; break; }
      const weight = hit ? hit.weight : byteLength(record);
      if (!hit && w.now() - record.at > SETTLED) w.records.set(`${sid}:${record.rev}`, { record, weight, at: w.now() });
      if (changes.length && size + weight > SYNC_BYTES) { stopped = true; capped = true; break; }
      changes.push(record);
      size += weight;
      next++;
    }
  }
  if (next <= rev && !stopped) capped = true;
  // Bytes read count, not bytes returned: a capped answer still read its last batch.
  if (read) await meter(w, sid, 'rdb', ident.uuid, read, READ_BUDGET);
  if (snap === undefined) snap = w.snapMetas.get(sid)?.value;
  // A missing record that the snapshot already covers (expired or lost) means reload.
  if (!changes.length && snap && snap.rev >= since + 1) return { rev, reset: true };
  if (snap !== undefined && needsRebuild(w, snap, rev)) w.waitUntil(rebuild(w, sid, kindOf(s)).catch(() => {}));
  return { rev, changes, ...(capped ? { more: true } : {}) };
}

/** `{since}`: rebuilds the snapshot when record `since+1` is still missing. */
export async function repair(w, ident, input) {
  const since = sinceOf(input.since);
  const { sid, s } = await member(w, ident, input, { rev: true });
  throttle(w, `repair:${sid}:${ident.uuid}`, 6, 60_000);
  const [head, snap] = await w.kv.getMany([K.ch(sid, since + 1, 0), K.snap(sid)]);
  let readable = Boolean(head);
  if (head?.parts > 1) {
    const rest = await w.kv.getMany(Array.from({ length: head.parts - 1 }, (_, n) => K.ch(sid, since + 1, n + 1)));
    readable = Boolean(assemble([head, ...rest]));
  }
  let meta = snap ?? null;
  if (since < (s.rev ?? 0) && !readable && (!meta || meta.rev <= since)) meta = (await rebuild(w, sid, kindOf(s))) ?? meta;
  return { snap: meta };
}

export async function snapshot(w, ident, input) {
  const { sid, s } = await member(w, ident, input, { rev: true });
  throttle(w, `snapshot:${sid}:${ident.uuid}`, 20, 60_000);
  metered(w, sid, 'snb', ident.uuid, SNAPSHOT_BUDGET);
  // A snapshot older than the last scrub may still hold deleted content.
  const found = await snapshotBytes(w, sid, kindOf(s), { rev: s.rev ?? 0, clean: await w.kv.get(K.scrub(sid)) });
  if (!found) fail('snapshot_pending', 503, { retryAfter: Math.min(10, rebuildWait(w)) });
  await meter(w, sid, 'snb', ident.uuid, found.bytes.byteLength, SNAPSHOT_BUDGET);
  return bytesResponse(found.bytes, { type: 'application/gzip', headers: { 'X-Trips-Rev': String(found.meta.rev) } });
}

/** Metadata for several spaces on this worker; unavailable ones are omitted. */
export async function heads(w, ident, input) {
  const ids = input.spaces;
  check(Array.isArray(ids) && ids.length <= 500 && ids.every(isId), 'invalid_spaces');
  throttle(w, `heads:${ident.uuid}`, 30, 60_000);
  // Spaces this worker does not host cost no reads.
  const hosted = await w.hosted(ids);
  const unique = [...new Set(ids)].filter((id) => Object.hasOwn(hosted, id));
  const keys = unique.flatMap((id) => staleKeys(w, id, { uuid: ident.uuid, meta: true, rev: true }).map((key) => [id, key]));
  const values = await w.kv.getMany(keys.map(([, key]) => key));
  keys.forEach(([id, key], index) => absorb(w, id, key, values[index]));
  const out = {};
  for (const id of unique) {
    const s = w.spaces.get(id);
    if (!s?.doc || s.doc.deleted) continue;
    const role = roleOf(s, ident.uuid);
    const title = titleOf(kindOf(s), s.meta);
    if (!role || !title) continue;
    out[id] = { rev: s.rev ?? 0, title, start: s.meta?.start ?? null, end: s.meta?.end ?? null, role };
  }
  return { heads: out };
}

export async function open(w, ident, input) {
  const { sid, s, role } = await member(w, ident, input, { rev: true, meta: true });
  throttle(w, `open:${sid}:${ident.uuid}`, 30, 60_000);
  const [record, filesMode] = await w.kv.getMany([K.handles(sid, ident.uuid), K.filesMode(sid)]);
  const owner = role === 'owner';
  // Shares are granted and revoked by username, so keep the stored one current.
  if (ident.username && recordOf(s, ident.uuid)?.username !== ident.username) {
    await w.kv.update(K.member(sid, ident.uuid), { username: ident.username });
    setMember(w, sid, ident.uuid, { ...recordOf(s, ident.uuid), username: ident.username });
  }
  // A member whose handle or file share stopped working asks for it again, at most 3 times per 10 minutes.
  const renew = input.renew === true && !owner && w.limiter.take(`renew:${sid}:${ident.uuid}`, 3, RENEW_WINDOW);
  const { access, mode } = owner ? { access: record ?? {}, mode: filesMode } : await ensureAccess(w, sid, s, ident, role, record, filesMode, { renew });
  if (owner) w.waitUntil(maintain(w, sid, kindOf(s)).catch(() => {}));
  // Any member's open sweeps every inbox, so a member who writes there and never calls `file.put` is still swept.
  if (mode === 'direct') await sweepSoon(w, sid);
  return {
    kind: kindOf(s), role, rev: s.rev ?? 0, protocol: PROTOCOL,
    ...(access.read && access.write ? { handles: { read: access.read, write: access.write } } : {}),
    files: filesInfo(s.doc, mode, access, owner),
  };
}

/** Worker presence fallback: ≤1 write per member per 2 minutes. */
export async function pres(w, ident, input) {
  const { sid, s } = await member(w, ident, input);
  throttle(w, `pres:${sid}:${ident.uuid}`, 6, 60_000);
  const now = w.now();
  let cached = w.presence.get(sid);
  if (!cached || now - cached.at > 30_000) {
    cached = { value: (await w.kv.get(K.pres(sid))) ?? {}, at: now };
    w.presence.set(sid, cached);
  }
  const last = Math.max(Number(own(cached.value, ident.uuid)) || 0, w.presenceWrites.get(`${sid}:${ident.uuid}`) ?? 0);
  if (now - last >= PRESENCE_WRITE) {
    await w.kv.update(K.pres(sid), { [ident.uuid]: now });
    w.presenceWrites.set(`${sid}:${ident.uuid}`, now);
    cached.value = { ...cached.value, [ident.uuid]: now };
  }
  const recent = Object.entries(cached.value).filter(([, at]) => Number.isFinite(at) && now - at <= PRESENCE_ACTIVE);
  await loadRecords(w, sid, recent.map(([uuid]) => uuid));
  return { active: Object.fromEntries(recent.filter(([uuid]) => roleOf(s, uuid))) };
}

/** `{before}` → older chat messages, newest first. */
export async function chatPage(w, ident, input) {
  const { sid } = await member(w, ident, input);
  check(input.before === undefined || isId(input.before), 'invalid_before');
  const limit = input.limit === undefined ? 100 : input.limit;
  check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 200, 'invalid_limit');
  throttle(w, `chat:${sid}:${ident.uuid}`, 20, 60_000);
  metered(w, sid, 'rdb', ident.uuid, READ_BUDGET);
  const { items, more } = await recentMessages(w, sid, limit, input.before);
  await meter(w, sid, 'rdb', ident.uuid, items.reduce((sum, item) => sum + byteLength(item), 0), READ_BUDGET);
  return { msgs: items.filter(({ value }) => value && typeof value === 'object').map(({ value }) => ({ t: 'msg', ...value })), more };
}
