import { invariant } from '../../shared/errors.js';
import { isId, newId } from '../../shared/ids.js';
import { isDate } from '../../shared/dates.js';
import { validateSpaceRef } from '../../shared/protocol.js';
import { plainObject, safeKey } from '../../shared/schema/dsl.js';
import { validateEntity } from '../../shared/schema/index.js';
import { accountIdentity } from '../puter.js';
import { lastIdentity } from '../identity.js';

const PREFIX = 'personal:';
const QUEUE = 'personal:queue';
const FAILED = 'personal:failed';
const PRIVATE_TYPES = new Set(['pack', 'exp']);
const ROLES = new Set(['owner', 'editor', 'viewer']);
const RETRY = new Set([0, 401, 402, 408, 429]);

function validateKey(key) {
  invariant(typeof key === 'string' && /^me:[a-zA-Z0-9:_-]{1,200}$/.test(key), 'invalid_personal_key');
  invariant(!/^me:(?:cred|worker|vault|integrations)(?::|$)/.test(key), 'private_store_required');
}

function spaceEntry(value) {
  invariant(plainObject(value), 'invalid_space_entry');
  validateSpaceRef(value.ref);
  invariant(ROLES.has(value.role), 'invalid_space_entry');
  const entry = { ref: { w: value.ref.w, s: value.ref.s, k: value.ref.k }, role: value.role, title: typeof value.title === 'string' ? value.title.slice(0, 500) : '' };
  for (const field of ['start', 'end']) if (value[field] != null) { invariant(isDate(value[field]), 'invalid_space_entry'); entry[field] = value[field]; }
  if (value.cover != null) entry.cover = value.cover;
  if (value.opened != null) { invariant(Number.isSafeInteger(value.opened) && value.opened >= 0, 'invalid_space_entry'); entry.opened = value.opened; }
  if (value.handles != null) {
    invariant(plainObject(value.handles) && ['read', 'write'].every((name) => typeof value.handles[name] === 'string' && value.handles[name].length <= 256), 'invalid_space_entry');
    entry.handles = { read: value.handles.read, write: value.handles.write };
  }
  const files = filesEntry(value.files);
  if (files) entry.files = files;
  return entry;
}

const fsUid = (value) => typeof value === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(value);
/** The `files` block of `open`/`join` (`{mode, uid?, inbox?}`), or null when absent or malformed. */
export function filesEntry(value) {
  if (!plainObject(value) || !['direct', 'proxied'].includes(value.mode)) return null;
  if (value.mode === 'proxied') return { mode: 'proxied' };
  return { mode: 'direct', ...(fsUid(value.uid) ? { uid: value.uid } : {}), ...(fsUid(value.inbox) ? { inbox: value.inbox } : {}) };
}
const sameRef = (a, b) => a.w === b.w && a.s === b.s;

/**
 * Personal `me:*` data. Reads answer from the IndexedDB cache and revalidate against the cloud at most every
 * `revalidateMs`; `subscribe(key, fn)` sees cloud changes, including other devices through `watch()`.
 */
export function createPersonalStore({ puter, db, now = Date.now, revalidateMs = 30_000, makeId = newId, locks = globalThis.navigator?.locks, onError = () => {}, window: target = globalThis.window }) {
  const session = puter.authToken;
  const listeners = new Map();
  const checkedAt = new Map();
  let verified;
  let flushing;
  const account = async () => {
    invariant(session && puter.authToken === session, 'account_changed', 401);
    // A failed lookup (offline) is retried next time; a different account stays refused.
    verified ??= accountIdentity(puter).then((user) => invariant(user.uuid === db.account, 'account_changed', 401))
      .catch((error) => { if (error.code !== 'account_changed') verified = undefined; throw error; });
    try { await verified; } catch (error) {
      // Offline cold start: the identity this device remembered for this exact token stands in until a lookup works.
      const offline = !(error?.status >= 400) && (error instanceof TypeError || error?.code === 'offline' || globalThis.navigator?.onLine === false);
      if (!offline || (await lastIdentity(session))?.uuid !== db.account) throw error;
    }
    invariant(puter.authToken === session, 'account_changed', 401);
  };
  const notify = (key, value) => { for (const listener of listeners.get(key) ?? []) listener(value); };
  const exclusive = (task) => locks?.request ? locks.request(`trips-spaces:${db.account}`, task) : task();

  // Queued private-item writes are replayed over any cloud value so local edits stay visible until sent.
  async function overlay(key, value) {
    const queue = (await db.get(QUEUE)) ?? [];
    let result = value;
    for (const item of queue.filter((entry) => entry.key === key)) {
      result = { ...(plainObject(result) ? result : {}) };
      if (item.op === 'remove') delete result[item.id]; else result[item.id] = item.value;
    }
    return result;
  }
  async function fromCloud(key) {
    const cloud = await puter.kv.get(key);
    await account();
    return absorb(key, cloud);
  }
  async function absorb(key, cloud) {
    checkedAt.set(key, now());
    const value = await overlay(key, cloud ?? undefined);
    const cached = await db.get(PREFIX + key);
    await account();
    if (JSON.stringify(cached) !== JSON.stringify(value)) {
      if (value === undefined) await db.remove(PREFIX + key); else await db.put(PREFIX + key, value);
      await account();
      notify(key, value);
    }
    return value;
  }
  function revalidate(key) {
    if (now() - (checkedAt.get(key) ?? -Infinity) < revalidateMs) return;
    checkedAt.set(key, now());
    void fromCloud(key).catch(() => { checkedAt.delete(key); });
  }
  async function cached(key) {
    const value = await db.get(PREFIX + key);
    await account();
    return value;
  }

  async function flush() {
    flushing ??= (async () => {
      try {
        for (;;) {
          await account();
          const [item] = (await db.get(QUEUE)) ?? [];
          if (!item) return { sent: true };
          let refused;
          try {
            if (item.op === 'remove') await puter.kv.remove(item.key, item.id);
            else await puter.kv.update(item.key, { [item.id]: item.value });
          } catch (error) {
            if (error?.code === 'account_changed' || RETRY.has(error?.status ?? 0) || (error?.status ?? 0) >= 500) return { sent: false, error };
            refused = error;
          }
          await account();
          await db.update(QUEUE, (queue = []) => queue.filter((entry) => entry.qid !== item.qid));
          if (refused) {
            // Kept for the user to see; the cache falls back to the cloud value.
            await db.update(FAILED, (failed = []) => [...failed, { ...item, code: typeof refused.code === 'string' ? refused.code : 'write_refused', at: now() }].slice(-100));
            await fromCloud(item.key).catch(() => {});
            onError(Object.assign(new Error('private_write_refused'), { code: 'private_write_refused', status: refused.status, key: item.key, id: item.id }));
          }
        }
      } finally { flushing = undefined; }
    })();
    return flushing;
  }

  function privateItems(spaceId, type) {
    invariant(isId(spaceId) && PRIVATE_TYPES.has(type), 'invalid_private_items');
    const key = `me:priv:${spaceId}:${type}`;
    async function queue(id, op, value) {
      await account();
      await db.update(QUEUE, (items = []) => [...items, { qid: makeId(), key, id, op, ...(op === 'remove' ? {} : { value }) }]);
      const next = await db.update(PREFIX + key, (current) => {
        const result = { ...(plainObject(current) ? current : {}) };
        if (op === 'remove') delete result[id]; else result[id] = value;
        return result;
      });
      await account();
      notify(key, next);
      void flush().catch(() => {});
      return op === 'remove' ? undefined : value;
    }
    const checked = (fields) => { validateEntity('trip', type, fields); return structuredClone(fields); };
    async function list() {
      await account();
      const value = await cached(key) ?? await fromCloud(key);
      if (value !== undefined) revalidate(key);
      return Object.values(plainObject(value) ? value : {}).filter((item) => plainObject(item) && isId(item.id));
    }
    return {
      key,
      list,
      async put(fields, id = makeId()) {
        invariant(isId(id), 'invalid_id');
        return queue(id, 'update', { ...checked(fields), id, upd: now() });
      },
      async patch(id, changes) {
        const current = (await list()).find((item) => item.id === id);
        invariant(current, 'gone', 409);
        const { id: _id, upd: _upd, ...fields } = current;
        return queue(id, 'update', { ...checked({ ...fields, ...changes }), id, upd: now() });
      },
      remove(id) { invariant(isId(id), 'invalid_id'); return queue(id, 'remove'); },
    };
  }

  const store = {
    async get(key, { fresh = false } = {}) {
      await account();
      validateKey(key);
      if (!fresh) {
        const value = await cached(key);
        if (value !== undefined) { revalidate(key); return value; }
      }
      return (await fromCloud(key)) ?? null;
    },
    async set(key, value) {
      await account();
      validateKey(key);
      await puter.kv.set(key, value);
      await account();
      await db.put(PREFIX + key, value);
      await account();
      checkedAt.set(key, now());
      notify(key, value);
      return value;
    },
    async patchPreferences(patch) {
      await account();
      invariant(plainObject(patch) && Object.keys(patch).every(safeKey), 'invalid_preferences');
      await puter.kv.update('me:prefs', patch);
      await account();
      const value = await db.update(PREFIX + 'me:prefs', (value) => ({ ...(value ?? {}), ...patch }));
      await account();
      notify('me:prefs', value);
      return value;
    },
    refresh(key) { validateKey(key); return account().then(() => fromCloud(key)); },
    subscribe(key, listener) {
      validateKey(key);
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(listener);
      return () => listeners.get(key)?.delete(listener);
    },
    /** Live updates for subscribed keys from this account's other sessions (values over 16 KB are re-read); flushes queued writes when back online. */
    async watch() {
      await account();
      const subscription = await puter.events.onLocal(`kv:${puter.appID}:me:*`, ({ event }) => {
        if (puter.authToken !== session) return;
        if (event?.op === 'gap') { for (const key of listeners.keys()) void fromCloud(key).catch(() => {}); return; }
        if (typeof event?.key !== 'string' || !listeners.has(event.key)) return;
        try { validateKey(event.key); } catch { return; }
        const update = Object.hasOwn(event, 'value') ? absorb(event.key, event.op === 'del' ? undefined : event.value) : fromCloud(event.key);
        void update.catch(() => {});
      }, { includeValue: true });
      const online = () => { void flush().catch(() => {}); };
      target?.addEventListener('online', online);
      return () => { target?.removeEventListener('online', online); void subscription.off?.(); };
    },
    flush,
    /** Private-item writes the cloud refused (for example too large), newest last. */
    async failedWrites() { await account(); return (await db.get(FAILED)) ?? []; },
    async dismissFailed(qid) { await account(); await db.update(FAILED, (failed = []) => failed.filter((entry) => entry.qid !== qid)); },
    privateItems,
    spaces: {
      async list() {
        const value = await store.get('me:spaces');
        return (Array.isArray(value) ? value : []).flatMap((item) => { try { return [spaceEntry(item)]; } catch { return []; } });
      },
      /** Read-modify-write of the cache index, serialized across this browser's tabs; the newest cloud value is re-read first. */
      async upsert(input) {
        const entry = spaceEntry(input);
        return exclusive(async () => {
          await account();
          const current = await fromCloud('me:spaces');
          const list = (Array.isArray(current) ? current : []).flatMap((item) => { try { return [spaceEntry(item)]; } catch { return []; } });
          const index = list.findIndex((item) => sameRef(item.ref, entry.ref));
          const next = index === -1 ? [...list, entry] : list.map((item, i) => i === index ? { ...item, ...entry } : item);
          await store.set('me:spaces', next);
          return next[index === -1 ? next.length - 1 : index];
        });
      },
      async remove(ref) {
        validateSpaceRef(ref);
        return exclusive(async () => {
          await account();
          const current = await fromCloud('me:spaces');
          const next = (Array.isArray(current) ? current : []).filter((item) => !(plainObject(item?.ref) && sameRef(item.ref, ref)));
          await store.set('me:spaces', next);
        });
      },
    },
  };
  return store;
}
