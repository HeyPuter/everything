import { invariant } from '../../shared/errors.js';
import { isUuid, newId } from '../../shared/ids.js';
import { can as allowed } from '../../shared/perms.js';
import { DOMAIN_OPS, validateSpaceRef } from '../../shared/protocol.js';
import { plainObject } from '../../shared/schema/dsl.js';
import { openSpaceStore } from './space.js';
import { createSelectors } from './query.js';
import { createHistory } from './history.js';
import { noteSeen, unreadCount } from './feed.js';
import { createOutbox } from '../outbox.js';
import { createSyncEngine, syncStatus } from '../sync/index.js';
import { createPathA, handleFailure, spaceScope } from '../sync/path-a.js';
import { createPathC } from '../sync/path-c.js';
import { createMemberRegion } from '../sync/presence.js';
import { featureSet, loadFeatures } from '../sync/features.js';
import { filesEntry } from './personal.js';

export { registerDomainAdapter } from './space.js';

const RETRY_A = 10 * 60_000;
const ROLES = Object.freeze(['owner', 'editor', 'viewer']);
// A space created moments ago in another region can answer `space_not_found` briefly; only a lasting one means gone.
const GONE_AFTER = 2 * 60_000;
const handlesFrom = (value) => plainObject(value) && typeof value.read === 'string' && typeof value.write === 'string' && value.read.length <= 256 && value.write.length <= 256
  ? { read: value.read, write: value.write } : null;
const issueOf = (error) => error?.code === 'worker_outdated' ? 'outdated' : null;

/**
 * Opens one space for views: replica, outbox, sync (path A through handles, the owner's own KV, or path C through the
 * worker), member regions, history and private items. See src/lib/README.md.
 */
export async function openSpace({
  ref, db, api, puter, personal, uid = db.account, role: initialRole = null, handles = null, files: initialFiles = null, ownWorker = null,
  view = '', features = null, open = true, autoStart = true, makeId = newId, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  document = globalThis.document, window = globalThis.window, onError = () => {}, onFlush = () => {},
}) {
  validateSpaceRef(ref);
  invariant(isUuid(uid) && uid === db.account, 'account_changed', 401);
  const owner = ref.w === ownWorker;
  const [store, flags] = await Promise.all([openSpaceStore({ ref, db, api, uid, now, makeId }), features ? featureSet(features) : loadFeatures()]);
  const listeners = new Set();
  const stateListeners = new Set();
  const cleanups = [];
  const privateItems = new Map();
  let role = initialRole;
  let current = flags.pathA ? handlesFrom(handles) : null;
  let files = filesEntry(initialFiles);
  let sync = 'idle';
  let issue = null;
  let handlesOff = false;
  let lastOpen = -Infinity;
  let lastRenew = -Infinity;
  // Handle ids that just failed; an `open` answering with one of them (an older worker ignores `renew`) is not used again.
  let dead = null;
  let accessPending = null;
  let missingSince = null;
  let restoreTimer;
  let closed = false;

  const emit = (event) => { if (!closed) for (const { filter, listener } of listeners) if (filter(event)) listener(event); };
  // Every store event re-reads the state; listeners hear only real changes.
  let lastState = '';
  const emitState = () => {
    if (closed) return;
    const value = space.state;
    const key = `${role}|${JSON.stringify(value)}`; // a role change alone still notifies
    if (key === lastState) return;
    lastState = key;
    for (const listener of stateListeners) listener(value);
  };
  // The caller's member entity is the worker's view of their role, so `can()` follows it; listeners of the change
  // (and `onState`) see the new role.
  function followRole({ save = true } = {}) {
    const next = store.get('member', uid)?.role;
    if (!ROLES.includes(next) || next === role) return;
    role = next;
    if (save) void remember({ role }).catch(() => {});
  }
  followRole({ save: false });
  cleanups.push(store.subscribe((event) => { if (event.changed?.has(`member:${uid}`)) followRole(); emit(event); emitState(); }));

  const region = createMemberRegion({ puter, api, ref, uid, writeHandle: owner ? null : current?.write ?? null, ownerPrefix: owner ? `shared:${ref.s}:` : null,
    personal, document, now, setTimer, clearTimer, onHandleError: (error) => { region.setWriteHandle(null); lostHandle(error, 'write'); },
    onChange: (member) => emit({ changed: new Set([`member:${member}`]), types: new Set(['presence']), rev: store.rev }) });
  // Only an unbroken run of `space_not_found` counts; any other failure restarts it.
  function noteMissing(error) {
    if (error?.code !== 'space_not_found') { missingSince = null; return; }
    missingSince ??= now();
    if (now() - missingSince >= GONE_AFTER) issue = 'gone';
  }
  function noteReachable() {
    missingSince = null;
    if (issue === 'gone') issue = null;
  }
  const pathC = createPathC({ store, api, uid });
  const creditPath = createPathC({ store, api, uid, minInterval: 60_000 });
  const pathFor = (value) => {
    if (owner) return createPathA({ store, puter, uid, scope: spaceScope(puter, { prefix: `shared:${ref.s}:` }), onRegion: region.receive });
    return value && !handlesOff && flags.pathA ? createPathA({ store, puter, uid, scope: spaceScope(puter, { handle: value.read }), onRegion: region.receive }) : null;
  };
  let pathA = pathFor(current);

  // `me:spaces` is a cache; an index write that fails is retried by the next `open`.
  async function remember(changes) {
    if (!personal?.spaces) return;
    const cached = (await personal.spaces.list()).find((entry) => entry.ref.w === ref.w && entry.ref.s === ref.s);
    if (cached && Object.entries(changes).every(([key, value]) => JSON.stringify(cached[key]) === JSON.stringify(value))) return;
    const meta = store.get('meta', 'meta');
    await personal.spaces.upsert({ ref, role: cached?.role ?? 'viewer', title: meta?.title ?? meta?.name ?? cached?.title ?? '', ...changes });
  }
  /** Calls `open`: at most every 10 minutes, and with `renew` at most every 10 minutes on its own clock. */
  async function reopen({ renew = false } = {}) {
    if (owner || closed) return;
    if (now() - (renew ? lastRenew : lastOpen) < RETRY_A) return;
    if (renew) lastRenew = now();
    lastOpen = now();
    try {
      const result = await api.call(ref, 'open', renew ? { renew: true } : {});
      if (closed) return;
      if (ROLES.includes(result?.role)) role = result.role;
      const next = handlesFrom(result?.handles);
      const access = filesEntry(result?.files);
      if (access) files = access;
      if (next || access) await remember({ ...(role ? { role } : {}), ...(next ? { handles: next } : {}), ...(access ? { files: access } : {}) }).catch(() => {});
      if (closed || !next || handlesOff || !flags.pathA) return;
      if (dead && now() - dead.at < RETRY_A && (next.read === dead.read || next.write === dead.write)) return;
      dead = null;
      current = next;
      region.setWriteHandle(next.write);
      pathA = pathFor(next);
      engine.use(pathA);
      void pathA.regions().catch(() => {});
    } catch (error) { if (!closed) onError(error); }
  }
  // An unusable handle: off for the session when the platform disables handles, otherwise ask the worker to re-share it.
  function lostHandle(error, which) {
    if (owner) return;
    dead = { ...(dead && now() - dead.at < RETRY_A ? dead : {}), [which]: current?.[which], at: now() };
    if ((error?.code ?? error?.error?.code) === 'kv_handles_disabled') handlesOff = true;
    else void reopen({ renew: true });
  }
  function fallback(error, adapter) {
    if (adapter.name !== 'A') return null;
    const kind = handleFailure(error);
    if (kind === 'credit') {
      clearTimer(restoreTimer);
      restoreTimer = setTimer(() => { if (!closed && pathA) engine.use(pathA); }, RETRY_A);
      return creditPath;
    }
    if (kind !== 'handle' || owner) return null;
    region.setWriteHandle(null);
    lostHandle(error, 'read');
    return pathC;
  }
  // The outbox and the engine can share one flush result; report each once.
  const reported = new WeakSet();
  const report = (result) => { if (!reported.has(result)) { reported.add(result); onFlush(result); } };
  const engine = createSyncEngine({ store, api, uid, adapter: pathA ?? pathC, fallback, document, window, now, setTimer, clearTimer, onFlush: report,
    onError: (error) => { issue = issueOf(error) ?? (issue === 'outdated' ? null : issue); noteMissing(error); onError(error); },
    onState: (value, { ok = false, worker = false } = {}) => { sync = value; if (ok) noteReachable(); if (worker && issue === 'outdated') issue = null; emitState(); },
    onPath: (name, reason) => { issue = name === 'C' && handleFailure(reason) === 'credit' ? 'credit' : null; emitState(); } });

  async function flushNow() {
    let result = await store.flush();
    for (let round = 0; !closed && (result.retry || ['conflict', 'rejected'].includes(result.status)); round++) {
      if (!result.retry) report(result);
      if (!store.pending.length || round === 8) break;
      result = await store.flush();
    }
    if (closed) return result;
    if (result.status === 'sent') { if (issue === 'outdated') issue = null; noteReachable(); void engine.sync(); }
    else {
      if (result.error && result.status !== 'conflict') { sync = syncStatus(result.error); issue = issueOf(result.error) ?? issue; noteMissing(result.error); }
      else if (store.conflicts.length) sync = 'conflict';
      emitState();
    }
    return result;
  }
  const outbox = createOutbox({ store: { apply: (ops) => store.apply(ops), flush: flushNow }, setTimer, clearTimer, onError });
  const history = createHistory({ apply: (ops) => outbox.apply(ops), get: (type, id) => store.get(type, id), makeId });

  async function loadPrivate(type) {
    if (ref.k !== 'trip' || !personal?.privateItems) return;
    const items = personal.privateItems(ref.s, type);
    const set = (list) => { privateItems.set(type, Object.freeze(list.map((item) => Object.freeze({ ...item, private: true })))); emit({ changed: new Set(list.map((item) => `${type}:${item.id}`)), types: new Set([type]), rev: store.rev, private: true }); };
    cleanups.push(personal.subscribe(items.key, (value) => set(Object.values(plainObject(value) ? value : {}))));
    try { set(await items.list()); } catch (error) { onError(error); }
  }
  const selectors = createSelectors({ kind: ref.k, source: (type) => store.entities(type), get: (type, id) => store.get(type, id), subscribe: (type, listener) => space.subscribe(type, listener) });

  const ops = {
    create(type, fields, { id = makeId() } = {}) { return { opId: makeId(), t: type, id, put: structuredClone(fields) }; },
    /** `base: true` sends the last server version so a concurrent edit parks a 409 (conflict-checked types only). */
    patch(type, id, { set, unset } = {}, { base = false } = {}) {
      const version = base ? store.serverVersion(type, id) : undefined;
      return { opId: makeId(), t: type, id, ...(set && Object.keys(set).length ? { set: structuredClone(set) } : {}), ...(unset?.length ? { unset: [...unset] } : {}), ...(version ? { base: version } : {}) };
    },
    remove(type, id, { base = false } = {}) {
      const version = base ? store.serverVersion(type, id) : undefined;
      return { opId: makeId(), t: type, id, del: true, ...(version ? { base: version } : {}) };
    },
    /** `newIds` is a list of names (one id each) or `{name: count}` (an array each). */
    domain(name, args = {}, newIds = []) {
      invariant(DOMAIN_OPS.includes(name), 'invalid_domain_op');
      const ids = Array.isArray(newIds) ? Object.fromEntries(newIds.map((key) => [key, makeId()]))
        : Object.fromEntries(Object.entries(newIds).map(([key, count]) => [key, Array.from({ length: count }, () => makeId())]));
      return { opId: makeId(), do: name, args: { ...structuredClone(args), ...(Object.keys(ids).length ? { newIds: ids } : {}) } };
    },
  };

  const space = {
    ref,
    store,
    select: selectors,
    ops,
    history,
    get role() { return role; },
    get state() {
      const skipped = store.skipped.length;
      return { path: engine.path, sync, issue: issue ?? (skipped ? 'outdated' : null), skipped, rev: store.rev, pending: store.pending.length,
        conflicts: store.conflicts.length, handles: Boolean(current) || owner };
    },
    can(action) { return allowed(role, action, store.get('meta', 'meta')?.perms ?? {}); },
    get: (type, id) => store.get(type, id),
    overlay: (type, id) => store.overlay(type, id),
    query(type, { where, sort, includePrivate = false } = {}) {
      let items = selectors[type]?.all() ?? store.entities(type);
      if (includePrivate && privateItems.has(type)) items = [...items, ...privateItems.get(type)];
      if (where) items = items.filter(where);
      return sort ? [...items].sort(sort) : items;
    },
    /** `subscribe(fn)`, `subscribe(type, fn)` or `subscribe({type, id}, fn)`; events carry `{changed, types, rev}`. */
    subscribe(target, listener) {
      const [filter, callback] = typeof target === 'function' ? [() => true, target]
        : typeof target === 'string' ? [(event) => event.types.has(target), listener]
          : [(event) => event.changed.has(`${target.type}:${target.id}`), listener];
      const entry = { filter, listener: callback };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
    onState(listener) { stateListeners.add(listener); return () => stateListeners.delete(listener); },
    /**
     * Validated, persisted and shown at once; sent after 400 ms or on `flush()`. `{history: label}` makes it undoable;
     * `inverse` gives the undo ops for domain ops.
     */
    async apply(list, { history: label, inverse } = {}) {
      const recorded = label ? history.record(label, list, { inverse }) : false;
      try { await outbox.apply(list); }
      catch (error) { if (recorded) history.forget(); throw error; }
      emitState();
    },
    flush: () => outbox.flush(),
    sync: () => engine.sync(),
    resolveConflict: async (opId, choice) => { const op = await store.resolveConflict(opId, choice); if (op) void outbox.flush(); return op; },
    conflicts: () => store.conflicts,
    privateItems(type) {
      invariant(ref.k === 'trip' && personal?.privateItems, 'private_items_unavailable');
      const items = personal.privateItems(ref.s, type);
      return { list: () => privateItems.get(type) ?? [], put: (fields, id) => items.put(fields, id), patch: (id, changes) => items.patch(id, changes), remove: (id) => items.remove(id) };
    },
    members() {
      const presence = new Map(region.members().map((member) => [member.uid, member]));
      return store.entities('member').map((member) => ({ uid: member.id, name: member.name, role: member.role, color: member.color, avatar: member.avatar,
        active: presence.get(member.id)?.active ?? false, view: presence.get(member.id)?.pres?.view ?? '', seen: presence.get(member.id)?.seen?.rev ?? null }));
    },
    /** `{mode: 'direct', owner?, account?, uid?, inbox?}` or `{mode: 'proxied'}` (see README). */
    async fileAccess() {
      if (!flags.directFiles) return { mode: 'proxied' };
      if (owner) return { mode: 'direct', owner: true, account: uid };
      if (!files && personal?.spaces) {
        try { files = (await personal.spaces.list()).find((entry) => entry.ref.w === ref.w && entry.ref.s === ref.s)?.files ?? null; } catch { /* asked below */ }
      }
      // Concurrent callers (a grid of thumbnails) share one `open`.
      if (!files && !closed) await (accessPending ??= reopen().finally(() => { accessPending = null; }));
      return files ?? { mode: 'proxied' };
    },
    /** Asks `open` again (rate-limited); `renew` re-shares handles and file folders that stopped working. */
    async refreshAccess({ renew = false } = {}) {
      await reopen({ renew });
      return space.fileAccess();
    },
    setView: (next) => region.setView(next),
    async markSeen(rev = store.rev) {
      await region.markSeen(rev);
      void noteSeen(db, ref, rev).catch(() => {});
    },
    feed: () => store.feed(),
    async unread() {
      const seen = await region.seen();
      void noteSeen(db, ref, seen).catch(() => {});
      return unreadCount(await store.feed(), { seen, uid });
    },
    async chatHistory({ cursor } = {}) {
      const adapter = engine.path === 'A' && pathA ? pathA : pathC;
      const page = await adapter.chatPage({ cursor });
      const messages = page.messages.filter((message) => message.t === 'msg');
      if (messages.length && !closed) await store.merge(messages);
      return { messages, cursor: page.cursor };
    },
    async start() {
      invariant(!closed, 'store_closed');
      if (personal?.flush) void personal.flush().catch(() => {});
      region.start(view);
      if (open && !current && !owner) void reopen();
      await engine.start();
      // Region keys come from member entities, so read them once the replica has loaded.
      if (!closed && pathA && engine.path === 'A') void pathA.regions().catch(() => {});
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimer(restoreTimer);
      engine.stop(); outbox.stop(); region.stop();
      for (const cleanup of cleanups.splice(0)) cleanup();
      listeners.clear(); stateListeners.clear();
      store.close();
    },
  };
  await Promise.all([loadPrivate('pack'), loadPrivate('exp')]);
  if (autoStart) await space.start();
  return space;
}
