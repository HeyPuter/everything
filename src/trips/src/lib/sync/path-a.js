import { invariant } from '../../shared/errors.js';
import { isUuid } from '../../shared/ids.js';
import { LIMITS } from '../../shared/limits.js';
import { plainObject } from '../../shared/schema/dsl.js';
import { validateEntity, validateTombstone } from '../../shared/schema/index.js';

const HANDLE_ERRORS = new Set(['kv_handle_not_found', 'kv_handle_access_denied', 'kv_handles_disabled']);
const ENTITY_KEY = /^e:([a-z][a-zA-Z0-9]{0,31}):([0-9a-z-]{4,36})$/;
const MARGIN = 20;

/** `'credit'` for 402, `'handle'` for unusable handles, otherwise null (a normal failure with backoff). */
export function handleFailure(error) {
  const code = error?.code ?? error?.error?.code;
  const status = error?.status ?? error?.statusCode ?? error?.error?.status;
  if (status === 402 || code === 'insufficient_funds') return 'credit';
  return HANDLE_ERRORS.has(code) ? 'handle' : null;
}

/**
 * KV access to a space's `shared:<id>:` prefix: through a member's read handle (`{handle}`, relative keys) or, for the
 * owner whose worker writes into their own app namespace, directly (`{prefix}`).
 */
export function spaceScope(puter, { handle, prefix }) {
  invariant(typeof handle === 'string' ? handle.length > 0 && handle.length <= 256 && !prefix : /^shared:[0-9a-z]{16}:$/.test(prefix), 'invalid_scope');
  const config = handle ? { handle } : undefined;
  const absolute = (key) => handle ? key : prefix + key;
  const relative = (key) => handle ? key : key.slice(prefix.length);
  return {
    handle,
    relative,
    subject: (key) => handle ? `kv:${handle}:${key}` : `kv:${puter.appID}:${prefix}${key}`,
    get: (key) => config ? puter.kv.get(absolute(key), config) : puter.kv.get(absolute(key)),
    getMany: (keys) => config ? puter.kv.get(keys.map(absolute), config) : puter.kv.get(keys.map(absolute)),
    async list({ pattern, reverse = false, limit = 1000, cursor, returnValues = true }) {
      const page = await puter.kv.list({ pattern: `${absolute(pattern)}*`, returnValues, reverse, limit, ...(cursor ? { cursor } : {}), ...(config ? { optConfig: config } : {}) });
      invariant(plainObject(page) && Array.isArray(page.items), 'invalid_list_response', 502);
      return { items: page.items.map((item) => returnValues ? { key: relative(item.key), value: item.value } : relative(item)), cursor: typeof page.cursor === 'string' && page.cursor ? page.cursor : null };
    },
  };
}

// Invalid items are skipped so one bad value cannot block a load.
function entityFrom(kind, type, value) {
  if (!plainObject(value)) return null;
  try {
    if (value.deleted === true) { const tombstone = { ...value, t: type }; validateTombstone(tombstone); return tombstone; }
    const { t: _ignored, ...data } = value;
    validateEntity(kind, type, data, { server: true });
    return { ...data, t: type };
  } catch { return null; }
}

function recordFrom(value, rev) {
  if (!plainObject(value) || value.rev !== rev || !Array.isArray(value.ents) || !Array.isArray(value.del)) return null;
  const parts = value.parts ?? 1;
  if (!Number.isSafeInteger(parts) || parts < 1 || parts > 1000) return null;
  return { rev, at: value.at, by: value.by, parts, ents: [...value.ents], del: [...value.del], ...(Array.isArray(value.sum) ? { sum: [...value.sum] } : {}) };
}
const range = (from, to) => Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);
const plain = ({ parts: _parts, ...record }) => record;

/** Path A: the member reads `shared:<id>:` through KV and pays for it. `onRegion(uuid, field, value)` gets `u:*` writes. */
export function createPathA({ store, puter, scope, uid, onRegion = () => {} }) {
  let loaded = false;

  // Contiguous records stop at the first unreadable one; `contiguous: false` keeps every complete record in range.
  // `first` is chunk 0 of record `from` when the caller already read it.
  async function records(from, to, { contiguous = true, first = null } = {}) {
    const found = first ? [first] : [];
    const start = first ? from + 1 : from;
    const heads = start <= to ? await scope.getMany(range(start, to).map((rev) => `ch:${rev}:0`)) : [];
    for (let index = 0; index < heads.length; index++) {
      const record = recordFrom(heads[index], start + index);
      if (!record) { if (contiguous) break; continue; }
      found.push(record);
    }
    const extra = found.flatMap((record) => range(1, record.parts - 1).map((part) => [record, part]));
    for (let offset = 0; offset < extra.length; offset += 100) {
      const slice = extra.slice(offset, offset + 100);
      const chunks = await scope.getMany(slice.map(([record, part]) => `ch:${record.rev}:${part}`));
      chunks.forEach((chunk, index) => {
        const [record] = slice[index];
        if (!plainObject(chunk) || chunk.rev !== record.rev || !Array.isArray(chunk.ents) || !Array.isArray(chunk.del)) { record.missing = true; return; }
        record.ents.push(...chunk.ents); record.del.push(...chunk.del);
        if (Array.isArray(chunk.sum)) record.sum = [...(record.sum ?? []), ...chunk.sum];
      });
    }
    if (!contiguous) return found.filter((record) => !record.missing).map(plain);
    const complete = found.findIndex((record) => record.missing);
    return (complete === -1 ? found : found.slice(0, complete)).map(plain);
  }

  async function catchUp(active, target, first = null) {
    let applied = false;
    let remote = false;
    while (store.rev < target) {
      const from = store.rev + 1;
      const to = Math.min(target, from + 99);
      const batch = await records(from, to, { first: first?.rev === from ? first : null });
      first = null;
      if (!active()) return null;
      if (!batch.length) return { applied, remote, behind: true };
      await store.receive(batch);
      if (!active()) return null;
      applied = true;
      remote ||= batch.some((record) => record.by !== uid);
      if (batch.length < to - from + 1) return { applied, remote, behind: true };
    }
    return { applied, remote, behind: false };
  }

  const sigFrom = (sig) => plainObject(sig) && Number.isSafeInteger(sig.rev) && sig.rev >= 0 ? sig : null;
  async function readSig() { return sigFrom(await scope.get('sig')); }

  // A full listing of `e:*` is the repair point. A sig read older than the replica waits for the next poll.
  async function load(active) {
    const sig = await readSig();
    if (!active()) return null;
    const rev = sig?.rev ?? 0;
    if (rev < store.rev) return { applied: false, remote: false, behind: true };
    const ents = [];
    const tombstones = [];
    let invalid = false;
    let cursor = null;
    do {
      const page = await scope.list({ pattern: 'e:', cursor });
      if (!active()) return null;
      for (const { key, value } of page.items) {
        const match = ENTITY_KEY.exec(key);
        if (!match) continue;
        const entity = entityFrom(store.ref.k, match[1], value);
        if (entity) (entity.deleted ? tombstones : ents).push(entity);
        else invalid = true;
      }
      cursor = page.cursor;
      invariant(ents.length + tombstones.length <= LIMITS.entities * 2, 'space_too_large', 413);
    } while (cursor);
    const chat = await scope.list({ pattern: 'm:', reverse: true, limit: LIMITS.chatPage });
    if (!active()) return null;
    for (const { value } of chat.items) { const message = entityFrom(store.ref.k, 'msg', value); if (message && !message.deleted) ents.push(message); }
    await store.replace({ rev, ents, tombstones }, { invalid });
    if (!active()) return null;
    // A commit below R0 may still have been writing entities during the listing; its record (written first) fills them in.
    const margin = rev > 0 ? await records(Math.max(1, rev - MARGIN + 1), rev, { contiguous: false }) : [];
    // One write for the margin; entities this client cannot validate are skipped and recorded.
    if (margin.length) await store.merge(margin.flatMap((record) => record.ents), margin.flatMap((record) => record.del.map((item) => ({ ...item, deleted: true, rev: record.rev }))), { lenient: true });
    if (!active()) return null;
    loaded = true;
    const next = await readSig();
    if (!active()) return null;
    const more = next && next.rev > store.rev ? await catchUp(active, next.rev) : { applied: false, remote: false, behind: false };
    return more && { applied: true, remote: true, behind: more.behind };
  }

  function region(key, value) {
    const match = /^u:([0-9a-f-]{36}):(pres|seen)$/.exec(key);
    if (match && isUuid(match[1])) onRegion(match[1], match[2], value);
  }

  return {
    name: 'A',
    scope,
    async pull(active) {
      // Data an earlier session skipped is re-listed, so a reloaded newer build can read it.
      if (!loaded && (store.rev === 0 || store.reread)) return load(active);
      loaded = true;
      // Concurrent commits can write `sig` out of order, so each poll also reads the next record.
      const from = store.rev + 1;
      const [rawSig, rawNext] = await scope.getMany(['sig', `ch:${from}:0`]);
      if (!active()) return null;
      const sig = sigFrom(rawSig);
      const next = recordFrom(rawNext, from) || (sig?.rev === from ? recordFrom(sig, from) : null);
      const target = Math.max(sig?.rev ?? 0, next ? from : 0);
      if (target <= store.rev) return { applied: false, remote: false, behind: false };
      if (target === from && next?.parts === 1) {
        await store.receive([plain(next)]);
        return active() ? { applied: true, remote: next.by !== uid, behind: false } : null;
      }
      return catchUp(active, target, next);
    },
    repair(active) { return load(active); },
    /** One reverse page of `m:*`; pass the returned cursor for the next older page. */
    async chatPage({ cursor } = {}) {
      const page = await scope.list({ pattern: 'm:', reverse: true, limit: LIMITS.chatPage, cursor });
      const messages = page.items.map(({ value }) => entityFrom(store.ref.k, 'msg', value)).filter((message) => message && !message.deleted);
      return { messages, cursor: page.cursor };
    },
    /** Presence and read markers of the space's members, one batched read on open; events keep them current. */
    async regions() {
      const keys = store.entities('member').slice(0, LIMITS.members).flatMap((member) => [`u:${member.id}:pres`, `u:${member.id}:seen`]);
      if (!keys.length) return;
      const values = await scope.getMany(keys);
      keys.forEach((key, index) => { if (values[index] != null) region(key, values[index]); });
    },
    async subscribe(notify, active) {
      const onSig = async ({ event }) => {
        if (!active()) return;
        if (event?.op === 'gap') { notify({ op: 'gap' }); return; }
        const record = event?.value && Number.isSafeInteger(event.value.rev) && event.value.rev === store.rev + 1 ? recordFrom(event.value, event.value.rev) : null;
        if (record && record.parts === 1) {
          try {
            await store.receive([plain(record)]);
            if (active()) notify({ op: 'applied', remote: record.by !== uid });
            return;
          } catch { /* Fall back to a sync. */ }
        }
        if (active()) notify({ op: 'wake' });
      };
      const onUser = ({ event }) => {
        if (!active()) return;
        if (event?.op === 'gap') { notify({ op: 'gap' }); return; }
        if (typeof event?.key === 'string' && event.op !== 'expire') region(scope.relative(event.key), event.value ?? null);
      };
      const subscriptions = [];
      try {
        subscriptions.push(await puter.events.onLocal(scope.subject('sig'), onSig, { includeValue: true }));
        subscriptions.push(await puter.events.onLocal(scope.subject('u:*'), onUser, { includeValue: true }));
      } catch (error) { for (const item of subscriptions) void item.off?.(); throw error; }
      return () => { for (const item of subscriptions) void item.off?.(); };
    },
  };
}
