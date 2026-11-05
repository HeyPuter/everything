/**
 * An in-process stand-in for the Puter worker runtime, used by the tests and
 * by the browser dev harness (mock.html). It provides the two globals a
 * worker sees, `router` and `me`, and a dispatcher that turns a fetch-style
 * call into a route invocation the way puter.workers.exec() would, including
 * the `user` context for authenticated callers.
 *
 * The fake KV implements the same operations the real store offers (set, get,
 * del, incr, add, update, remove, expire, list, flush) with dot-path
 * semantics, so worker code runs unchanged.
 */

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const splitPath = (p) => String(p).split('.');

// Paths address own properties only, as a JSON store does: an inherited name
// (`constructor`) is not a value, and `__proto__` is never a segment, so no
// path can read or rewrite Object.prototype.
const ownAt = (obj, k) => obj != null && typeof obj === 'object' && Object.hasOwn(obj, k);
const checkSegment = (k) => {
  if (k === '__proto__') throw new Error(`Bad path segment: ${k}`);
  return k;
};

function getAt(obj, parts) {
  let cur = obj;
  for (const k of parts) {
    if (!ownAt(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function setAt(obj, parts, value) {
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = checkSegment(parts[i]);
    if (!ownAt(cur, k) || cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[checkSegment(parts[parts.length - 1])] = value;
}

function deleteAt(obj, parts) {
  const parent = getAt(obj, parts.slice(0, -1));
  const k = parts[parts.length - 1];
  if (ownAt(parent, k)) delete parent[k];
}

/**
 * createMemoryKv({ strictAdd, strictPaths, storage })
 *   strictAdd: make add() reject on a missing key, to exercise the worker's
 *              fallback path.
 *   strictPaths: refuse what puter.js's kv module refuses before any request
 *              goes out (src/puter-js/src/modules/kv/{update,incr,add,remove}.js,
 *              and the backend after it): a path map with no entries
 *              (`path_map_invalid`, "pathAndValueMap cannot be empty") for
 *              update/incr/add, and for remove a call with no path
 *              (`arguments_required`), a single array of paths in place of
 *              separate arguments (`paths_invalid`, "Paths must be provided
 *              as separate arguments"), or a path that is not a string. Off
 *              by default: the lenient store is what the browser harness runs
 *              on; tests turn it on to prove a call would fail on the real one.
 *   strictSize: hold every write to the store's 400 KB value ceiling, not
 *              only set(): a path write (update, incr, add) that would leave
 *              the document past it is refused, as the real store refuses
 *              the value whatever the call that grew it. Off by default; tests
 *              turn it on to prove a block or a document cannot grow past it.
 *   storage:   { load(): object|null, save(object) } for persistence (the
 *              browser harness backs it with localStorage so tabs share).
 */
export const VALUE_BYTES_MAX = 400 * 1024;

export function createMemoryKv({ strictAdd = false, strictPaths = false, strictSize = false, storage = null } = {}) {
  const refuse = (message, code) => Object.assign(new Error(message), { code });
  const assertPathMap = (pathMap) => {
    if (strictPaths && (!pathMap || typeof pathMap !== 'object' || Array.isArray(pathMap) || !Object.keys(pathMap).length)) throw refuse('pathAndValueMap cannot be empty', 'path_map_invalid');
  };
  const assertSize = (doc) => {
    if (strictSize && JSON.stringify(doc).length > VALUE_BYTES_MAX) throw refuse('Value too large', 'value_too_large');
  };
  // `log` is an ordered record of every mutating op (never a plain get/list),
  // { op, key }, so a test can assert on the *order* writes happened in
  // within one request — e.g. that the last thing a route touched was a
  // signal's shard write — not only on which keys ended up touched.
  const calls = { list: 0, ops: 0, log: [] };
  const shares = [];
  const ttl = new Map(); // key -> seconds, recorded for tests
  // key -> epoch ms; keys really do expire here, so rate limits and invite
  // budgets in the browser harness let go the way the real store's do. Kept
  // with the data under a reserved key so tabs sharing a store agree.
  const EXPIRES = '\u0000expires';
  let expires = new Map();
  let map = new Map();
  const load = () => {
    const { [EXPIRES]: exp, ...rest } = storage?.load() || {};
    map = new Map(Object.entries(rest));
    expires = new Map(Object.entries(exp || {}));
  };
  load();

  const sweep = () => {
    const t = Date.now();
    for (const [k, at] of expires) {
      if (at <= t) {
        expires.delete(k);
        map.delete(k);
      }
    }
  };
  const sync = () => {
    if (storage?.changed?.()) load();
    sweep();
  };
  const persist = () => {
    if (storage) storage.save({ ...Object.fromEntries(map), ...(expires.size ? { [EXPIRES]: Object.fromEntries(expires) } : {}) });
  };
  const has = (k) => map.has(k);
  const read = (k) => (map.has(k) ? clone(map.get(k)) : null);
  const write = (k, v) => {
    map.set(k, clone(v));
    persist();
  };
  const ensureObject = (k) => {
    const cur = map.has(k) ? clone(map.get(k)) : null;
    return cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {};
  };

  const kv = {
    _map: () => map,
    _calls: calls,
    _ttl: ttl,
    async set(k, v) {
      sync();
      calls.ops++;
      if (Array.isArray(k)) {
        for (const { key, value } of k) { write(key, value); calls.log.push({ op: 'set', key }); }
      } else {
        if (JSON.stringify(v).length > VALUE_BYTES_MAX) throw refuse('Value too large', 'value_too_large');
        expires.delete(k); // a fresh value has no expiry until expire() gives it one, as in Redis
        write(k, v);
        calls.log.push({ op: 'set', key: k });
      }
      return true;
    },
    async get(k) {
      sync();
      calls.ops++;
      // A list of keys reads as a list of values in the same order, null
      // where a key is absent, as the real store answers it (see the
      // worker's getMany).
      if (Array.isArray(k)) return k.map(read);
      return read(k);
    },
    async del(k) {
      sync();
      calls.ops++;
      map.delete(k);
      expires.delete(k);
      persist();
      calls.log.push({ op: 'del', key: k });
      return true;
    },
    async incr(k, amount = 1) {
      sync();
      calls.ops++;
      if (amount && typeof amount === 'object') {
        assertPathMap(amount);
        const doc = ensureObject(k);
        for (const [path, by] of Object.entries(amount)) {
          const parts = splitPath(path);
          const cur = Number(getAt(doc, parts)) || 0;
          setAt(doc, parts, cur + by);
        }
        assertSize(doc);
        write(k, doc);
        calls.log.push({ op: 'incr', key: k });
        return clone(doc);
      }
      const next = (Number(map.get(k)) || 0) + amount;
      write(k, next);
      calls.log.push({ op: 'incr', key: k });
      return next;
    },
    async decr(k, amount = 1) {
      return kv.incr(k, -amount);
    },
    async add(k, value = 1) {
      sync();
      calls.ops++;
      if (strictAdd && !has(k)) throw new Error('Key not found');
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        assertPathMap(value);
        const doc = ensureObject(k);
        for (const [path, v] of Object.entries(value)) {
          const parts = splitPath(path);
          const cur = getAt(doc, parts);
          if (Array.isArray(cur)) setAt(doc, parts, cur.concat(Array.isArray(v) ? v : [v]));
          else if (typeof cur === 'number') setAt(doc, parts, cur + Number(v));
          else if (typeof cur === 'string') setAt(doc, parts, cur + String(v));
          else setAt(doc, parts, Array.isArray(v) ? v : v);
        }
        assertSize(doc);
        write(k, doc);
        calls.log.push({ op: 'add', key: k });
        return clone(doc);
      }
      const cur = map.get(k);
      const next = Array.isArray(cur) ? cur.concat(value) : (Number(cur) || 0) + Number(value);
      write(k, next);
      calls.log.push({ op: 'add', key: k });
      return clone(next);
    },
    async update(k, pathMap) {
      sync();
      calls.ops++;
      assertPathMap(pathMap);
      const doc = ensureObject(k);
      for (const [path, v] of Object.entries(pathMap || {})) setAt(doc, splitPath(path), clone(v));
      assertSize(doc);
      write(k, doc);
      calls.log.push({ op: 'update', key: k });
      return clone(doc);
    },
    async remove(k, ...paths) {
      sync();
      calls.ops++;
      if (strictPaths) {
        // As puter.js's remove(key, ...paths) has it: separate string
        // arguments, at least one; an array handed as the one path is refused.
        if (!paths.length) throw refuse('At least one path is required', 'arguments_required');
        if (paths.length === 1 && Array.isArray(paths[0])) throw refuse('Paths must be provided as separate arguments', 'paths_invalid');
        if (paths.some((p) => typeof p !== 'string')) throw refuse('All paths must be strings', 'paths_invalid');
      }
      const doc = ensureObject(k);
      for (const p of paths.flat()) deleteAt(doc, splitPath(p));
      write(k, doc);
      calls.log.push({ op: 'remove', key: k });
      return clone(doc);
    },
    async expire(k, seconds) {
      ttl.set(k, seconds);
      if (map.has(k)) {
        expires.set(k, Date.now() + Number(seconds) * 1000);
        persist();
      }
      return true;
    },
    async expireAt() {
      return true;
    },
    async list(pattern, returnValues) {
      sync();
      calls.list++;
      let keys = [...map.keys()];
      if (typeof pattern === 'string') {
        const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        keys = keys.filter((x) => re.test(x));
      }
      return returnValues === true || pattern === true ? keys.map((x) => ({ key: x, value: read(x) })) : keys;
    },
    async flush() {
      map.clear();
      persist();
      return true;
    },
    // Shares as puter.kv.share / unshare answer them with the owner's
    // consent in place: one share per prefix and holder, kept (and its
    // handle with it) when made again, and stopping one twice answers twice.
    _shares: shares,
    async share({ prefix, recipient, access = 'read', label, notify } = {}) {
      const holder = recipient?.uid || recipient?.username || recipient;
      const p = String(prefix).endsWith(':') ? String(prefix) : `${prefix}:`;
      let s = shares.find((x) => x.prefix === p && x.holder === holder && !x.revokedAt);
      if (!s) {
        s = { handle: `kvh-${shares.length + 1}`, prefix: p, holder, label: null, notify: false, createdAt: Math.floor(Date.now() / 1000), revokedAt: null };
        shares.push(s);
      }
      s.access = access;
      if (label !== undefined) s.label = label;
      if (notify !== undefined) s.notify = notify;
      return { handle: s.handle, prefix: s.prefix, access: s.access, appUid: null, holder: s.holder, label: s.label, notify: s.notify, createdAt: s.createdAt };
    },
    async unshare(handle) {
      const s = shares.find((x) => x.handle === handle);
      if (!s) throw refuse('Not found', 'subject_does_not_exist');
      s.revokedAt ||= Math.floor(Date.now() / 1000);
      return { handle, revokedAt: s.revokedAt };
    },
  };
  return kv;
}

/**
 * A view of a KV that prefixes every key, so several fake workers (one per
 * mock user) can share one persisted store while seeing separate data, the
 * way separate Puter accounts would. `prefix()` is read per call, so the
 * harness can point it at whichever worker is handling the current request.
 */
export function namespacedKv(kv, prefix) {
  const p = () => (typeof prefix === 'function' ? prefix() : prefix) + '|';
  const wrap = (name) => async (k, ...rest) => kv[name](p() + k, ...rest);
  return {
    _calls: kv._calls,
    _ttl: kv._ttl,
    _map: kv._map,
    set: async (k, v) => (Array.isArray(k) ? kv.set(k.map((e) => ({ key: p() + e.key, value: e.value }))) : kv.set(p() + k, v)),
    get: async (k) => (Array.isArray(k) ? kv.get(k.map((x) => p() + x)) : kv.get(p() + k)),
    del: wrap('del'),
    incr: wrap('incr'),
    decr: wrap('decr'),
    add: wrap('add'),
    update: wrap('update'),
    remove: wrap('remove'),
    expire: wrap('expire'),
    expireAt: wrap('expireAt'),
    share: (options) => kv.share({ ...options, prefix: p() + options.prefix }),
    unshare: (handle) => kv.unshare(handle),
    async list(pattern, returnValues) {
      const out = await kv.list(typeof pattern === 'string' ? p() + pattern : p() + '*', returnValues);
      return out.map((x) => (typeof x === 'string' ? x.slice(p().length) : { ...x, key: x.key.slice(p().length) }));
    },
    flush: () => kv.flush(),
  };
}

/**
 * A tiny fs: paths to Blobs. Enough for attachment upload/download. With
 * `storage` ({ load(): object, save(object) }) the files persist as data
 * URLs, so the browser harness keeps attachments and photos across reloads
 * and between tabs the way a real drive would.
 */
export function createMemoryFs({ storage = null } = {}) {
  const files = new Map();
  let ready = Promise.resolve();
  if (storage) {
    ready = (async () => {
      for (const [path, dataUrl] of Object.entries(storage.load() || {})) {
        try {
          files.set(path, await (await fetch(dataUrl)).blob());
        } catch {
          /* skip what cannot be read back */
        }
      }
    })();
  }
  const persist = async () => {
    if (!storage) return;
    const out = {};
    for (const [path, blob] of files) out[path] = await toDataUrl(blob);
    storage.save(out);
  };
  return {
    _files: files,
    async write(path, data) {
      await ready;
      const blob = data instanceof Blob ? data : new Blob([data ?? '']);
      files.set(path, blob);
      await persist();
      return { path, size: blob.size };
    },
    async read(path) {
      await ready;
      if (!files.has(path)) throw new Error('File not found');
      return files.get(path);
    },
    async delete(path, { recursive = true } = {}) {
      await ready;
      // Puter deletes a directory with everything under it (`recursive`
      // defaults to true there too); the fake has no directories of its own,
      // so a path is a directory when files sit below it.
      files.delete(path);
      if (recursive) for (const k of [...files.keys()]) if (k.startsWith(`${path}/`)) files.delete(k);
      await persist();
      return true;
    },
  };
}

function toDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function compile(pattern) {
  const segs = pattern.split('/').filter(Boolean);
  return (pathname) => {
    const parts = pathname.split('/').filter(Boolean);
    const params = {};
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.startsWith('*')) {
        params[s.slice(1)] = parts.slice(i).map(decodeURIComponent).join('/');
        return params;
      }
      if (i >= parts.length) return null;
      if (s.startsWith(':')) params[s.slice(1)] = decodeURIComponent(parts[i]);
      else if (s !== parts[i]) return null;
    }
    return parts.length === segs.length ? params : null;
  };
}

export function createRouter() {
  const routes = [];
  const on = (method) => (pattern, handler) => {
    routes.push({ method, pattern, match: compile(pattern), handler });
  };
  return {
    routes,
    get: on('GET'), post: on('POST'), put: on('PUT'), delete: on('DELETE'), options: on('OPTIONS'),
    find(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const params = r.match(pathname);
        if (params) return { handler: r.handler, params };
      }
      return null;
    },
  };
}

function toResponse(out) {
  if (out instanceof Response) return out;
  if (out === undefined || out === null) return new Response('', { status: 204 });
  if (typeof out === 'string') return new Response(out, { headers: { 'Content-Type': 'text/plain' } });
  if (out instanceof Blob || out instanceof Uint8Array || out instanceof ReadableStream) return new Response(out);
  return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } });
}

/** The packed `au` claim a real v2 token carries: a uuid's hex packed to base64, or the id as it stands when stripping `app-` and its dashes leaves something that is not 32 hex characters — which is how the readable ids this suite uses (`app-teamchat-test`, `user-not-an-app`) survive the round trip, since a dashed value is exactly what appUidFromToken's decoder passes through unpacked. */
function packAppUid(appUid) {
  const hex = String(appUid).replace(/^app-/, '').replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) return appUid;
  const bytes = hex.match(/.{2}/g).map((b) => parseInt(b, 16));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * A workable fake of a Puter worker's own auth token: a three-part JWT whose
 * payload carries the app uid the way a real one does (see
 * src/shared/events.js `appUidFromToken`). `claim: 'au'`, the default, mints
 * the packed shape every v2 token actually carries; `claim: 'app_uid'` mints
 * the legacy, uncompressed one. Header and signature are filler; nothing
 * checks them.
 */
export function fakeAuthToken(appUid = 'app-4b1d9c20-7e3a-4f56-9a08-2c6d5e1f8b34', { claim = 'au' } = {}) {
  const seg = (obj) => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payload = claim === 'app_uid' ? { app_uid: appUid } : { au: packAppUid(appUid) };
  return `${seg({ alg: 'none' })}.${seg(payload)}.`;
}

/**
 * Install the globals and return a dispatcher. `loadWorker` imports the
 * worker module once the globals are in place. `owner` is what
 * `me.puter.auth.getUser()` answers: the account the worker runs in (a
 * `{ uuid, username }`, a function returning one, or null for a runtime that
 * cannot say, in which case the first creator claims the worker). `authToken`
 * defaults to null (a user-scoped worker, as most of the test suite wants:
 * events signalling reads it and comes back unavailable with no network
 * call), and `apiOrigin` to a placeholder host meaningful only once a test
 * stubs `globalThis.fetch` (see tests/push.test.js for the pattern).
 */
export async function createWorkerRuntime({ kv, fs, loadWorker, owner = null, authToken = null, apiOrigin = 'https://api.puter.test' }) {
  const router = createRouter();
  const notifications = { sent: [], async notify(n) { this.sent.push(n); return `notif-${this.sent.length}`; } };
  const stores = { kv, fs, owner, authToken, apiOrigin, onAnswered: null };
  globalThis.router = router;
  // Getters, so a test can swap in a fresh store without re-importing the
  // worker module (modules only evaluate once).
  globalThis.me = {
    puter: {
      notifications,
      get kv() { return stores.kv; },
      get fs() { return stores.fs; },
      get authToken() { return stores.authToken; },
      get APIOrigin() { return stores.apiOrigin; },
      auth: {
        async getUser() {
          const o = typeof stores.owner === 'function' ? stores.owner() : stores.owner;
          if (!o) throw new Error('owner unknown');
          return { ...o };
        },
      },
    },
  };
  await loadWorker();

  /**
   * dispatch(url, init, caller): caller is { uuid, username } for an
   * authenticated request (what user.puter.auth.getUser() would return),
   * optionally with `authToken` (what puter.workers.exec forwards as
   * user.puter.authToken) or `onIdentify` (run while getUser is answering),
   * or null for a plain fetch.
   */
  async function dispatch(url, init = {}, caller = null) {
    const request = url instanceof Request ? url : new Request(String(url), init);
    const u = new URL(request.url);
    const found = router.find(request.method.toUpperCase(), u.pathname);
    if (!found) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    // `onIdentify` stands in for the round trip to Puter that identifying a
    // caller really is: it runs before getUser answers, so a test can see
    // what the worker had already set going while it waited.
    const { authToken: callerToken = null, onIdentify = null, ...info } = caller || {};
    const getUser = async () => {
      if (onIdentify) await onIdentify();
      return { ...info };
    };
    const user = caller
      ? { puter: { authToken: callerToken, auth: { getUser }, getUser } }
      : undefined;
    // The real runtime's event carries waitUntil (see worker/lib.js's
    // settleDeferred): work handed to it runs after the answer goes out. Here
    // it is collected and settled before dispatch resolves, so a test sees
    // the same final state a deployed worker reaches a moment later.
    // `onAnswered` marks the moment the answer was ready, which is what a
    // test measuring a route's own latency has to count up to: everything
    // after it is work the caller is no longer waiting on.
    const pending = [];
    const waitUntil = (p) => { pending.push(Promise.resolve(p).catch(() => {})); };
    const answered = () => { if (typeof stores.onAnswered === 'function') stores.onAnswered(); };
    try {
      const out = await found.handler({ request, user, params: found.params, waitUntil });
      const res = toResponse(out);
      answered();
      while (pending.length) await Promise.all(pending.splice(0));
      return res;
    } catch (e) {
      answered();
      while (pending.length) await Promise.all(pending.splice(0));
      return new Response(JSON.stringify({ error: 'internal', message: String(e?.message || e) }), { status: 500 });
    }
  }

  function setStores(next) {
    notifications.sent.length = 0;
    if ('onAnswered' in next) stores.onAnswered = next.onAnswered;
    if (next.kv) stores.kv = next.kv;
    if (next.fs) stores.fs = next.fs;
    if ('owner' in next) stores.owner = next.owner;
    if ('authToken' in next) stores.authToken = next.authToken;
    if ('apiOrigin' in next) stores.apiOrigin = next.apiOrigin;
  }

  return { router, dispatch, setStores, notifications, get kv() { return stores.kv; }, get fs() { return stores.fs; } };
}
