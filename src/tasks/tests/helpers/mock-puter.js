/**
 * In-memory mock of the Puter SDK surface the store uses, plus the browser
 * globals (localStorage, window, navigator) the store expects. Install once
 * per test file; reset() between tests.
 *
 * createMockPuter() builds an isolated "account" (its own kv + fs); read
 * URLs minted by any account resolve through a global fetch mock, so
 * cross-account flows (shared lists, collaboration) can be tested.
 *
 * createMockPuter({ kvShares: true }) adds KV shares (puter.kv.share and
 * friends, handle-scoped kv ops, kv/notification events and the kvShare
 * consent). Without it the account behaves like an SDK that predates them.
 * Rejections carry { message, code } and no status, as the real SDK's do.
 */

/* All accounts' drives, keyed by account id, for the fetch mock. */
const drives = new Map();
let nextAccount = 0;

/* KV-share world: accounts by username (latest wins) and every share. */
const accounts = new Map();
const shares = new Map();
let nextHandle = 0;
let nextEvent = 0;

const APP_ID = 'app-tasks-test';
const LEVELS = ['watch', 'read', 'write'];
const PREFIX_SEGMENT = /^[a-z0-9_.-]+$/;

function fail(code, message = code) {
  // Plain object, like the SDK's rejections.
  throw { code, message };
}

function validPrefix(prefix) {
  const p = String(prefix || '').replace(/:$/, '');
  return p && p.split(':').every((s) => PREFIX_SEGMENT.test(s)) ? `${p}:` : null;
}

function checkLabel(label) {
  if (label === undefined || label === null) return label ?? null;
  if (typeof label !== 'string') fail('kv_share_label_invalid');
  const s = label.trim();
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s)) fail('kv_share_label_invalid');
  if ([...s].length > 128 || new TextEncoder().encode(s).length > 512) fail('kv_share_label_invalid');
  return s || null;
}

/** kv subject pattern (after the app id or handle): exact, or prefix with trailing '*'. */
function keyMatches(pattern, key) {
  return pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : key === pattern;
}

function deliver(acct, sub, event) {
  setTimeout(() => {
    if (acct.subs.has(sub)) sub.handler({ event });
  }, 0);
}

/** Fan a write in `owner`'s store out to every matching subscription. */
function emitKv(owner, fullKey, op, actor) {
  for (const acct of new Set(accounts.values())) {
    for (const sub of acct.subs) {
      if (!sub.subject.startsWith('kv:')) continue;
      const rest = sub.subject.slice(3);
      const cut = rest.indexOf(':');
      const head = rest.slice(0, cut);
      const pattern = rest.slice(cut + 1);
      let key = null;
      if (head === APP_ID) {
        if (acct === owner) key = fullKey;
      } else {
        const share = shares.get(head);
        if (share && !share.revokedAt && share.owner === owner && share.holderAcct === acct
          && fullKey.startsWith(share.prefix)) key = fullKey.slice(share.prefix.length);
      }
      if (key === null || !keyMatches(pattern, key)) continue;
      deliver(acct, sub, {
        id: `ev-${++nextEvent}`, subject: `kv:${head}:${key}`, op, key,
        self: actor === acct, viaWorker: false, ts: Date.now(),
      });
    }
  }
}

export function createMockPuter({ username = 'testuser', kvShares = false, kvSharesDisabled = false, consent = true } = {}) {
  const kv = new Map();
  const files = new Map();
  const accountId = ++nextAccount;
  drives.set(accountId, files);
  const uuid = `uuid-${username}-${accountId}`;
  const acct = { username, uuid, kv, subs: new Set(), consents: new Set() };
  if (kvShares) accounts.set(username, acct);

  /** Owner store + absolute key for a (possibly handle-scoped) kv call. */
  function scope(key, opts, level) {
    const handle = opts?.handle;
    if (!handle) return { store: kv, key, owner: acct };
    if (!kvShares) fail('kv_handle_not_found');
    const share = shares.get(handle);
    if (!share || share.revokedAt || share.holderAcct !== acct) fail('kv_handle_not_found');
    if (LEVELS.indexOf(share.access) < LEVELS.indexOf(level)) fail('kv_handle_access_denied');
    return { store: share.owner.kv, key: share.prefix + key, owner: share.owner, prefix: share.prefix };
  }

  function writeOne(key, value, opts) {
    const s = scope(key, opts, 'write');
    s.store.set(s.key, structuredClone(value));
    if (kvShares) emitKv(s.owner, s.key, 'set', acct);
  }

  const mock = {
    kv: {
      async get(key, opts) {
        const s = scope(key, opts, 'read');
        return s.store.has(s.key) ? structuredClone(s.store.get(s.key)) : null;
      },
      async set(key, value, opts) {
        if (Array.isArray(key)) {
          for (const item of key) writeOne(item.key, item.value, value);
          return true;
        }
        writeOne(key, value, opts);
        return true;
      },
      async del(key, opts) {
        const s = scope(key, opts, 'write');
        const had = s.store.delete(s.key);
        if (had && kvShares) emitKv(s.owner, s.key, 'del', acct);
        return true;
      },
      async list(pattern = '*', returnValues = false, opts = undefined) {
        if (typeof pattern === 'boolean') [pattern, returnValues, opts] = ['*', pattern, returnValues];
        const s = scope(String(pattern).replace(/\*$/, ''), opts, 'read');
        const strip = s.prefix ? s.prefix.length : 0;
        return [...s.store.keys()]
          .filter((k) => k.startsWith(s.key))
          .sort()
          .map((k) => (returnValues
            ? { key: k.slice(strip), value: structuredClone(s.store.get(k)) }
            : k.slice(strip)));
      },
    },
    fs: {
      async write(path, data) {
        files.set(path, String(data));
        return { path };
      },
      async read(path) {
        if (!files.has(path)) {
          const err = new Error('No such file');
          err.code = 'subject_does_not_exist';
          throw err;
        }
        return files.get(path);
      },
      async delete(path) {
        files.delete(path);
      },
      async getReadURL(path, expiresIn) {
        if (!files.has(path)) throw new Error('No such file');
        return `https://api.puter.example/read?u=${accountId}&path=${encodeURIComponent(path)}&ttl=${expiresIn}`;
      },
    },
    auth: {
      async getUser() {
        return { username, uuid };
      },
      async isSignedIn() {
        return true;
      },
    },
    env: 'web',
  };

  if (kvShares) {
    mock.appID = APP_ID;

    Object.assign(mock.kv, {
      async share(prefixOrOpts, recipient, access = 'read') {
        const o = typeof prefixOrOpts === 'object'
          ? { access: 'read', ...prefixOrOpts }
          : { prefix: prefixOrOpts, recipient, access };
        if (kvSharesDisabled) fail('kv_handles_disabled');
        const prefix = validPrefix(o.prefix);
        if (!prefix) fail('invalid_kv_share_prefix');
        if (!LEVELS.includes(o.access)) fail('kv_share_access_invalid');
        const name = typeof o.recipient === 'object' ? o.recipient?.username : o.recipient;
        if (typeof name !== 'string' || !name || name.includes('@')) fail('invalid_recipient');
        const holderAcct = accounts.get(name);
        if (!holderAcct) fail('subject_does_not_exist', 'No such user');
        if (holderAcct === acct) fail('bad_request');
        const delegated = [...acct.consents].some((c) => prefix.startsWith(c.prefix)
          && LEVELS.indexOf(c.access) >= LEVELS.indexOf(o.access));
        if (!delegated) fail('events_kv_handle_not_delegated');
        const label = checkLabel(o.label);

        const existing = [...shares.values()].find((s) => s.owner === acct && s.holderAcct === holderAcct
          && s.prefix === prefix && !s.revokedAt);
        if (existing) {
          existing.access = o.access;
          if (o.label !== undefined) existing.label = label;
          return shareRecord(existing);
        }
        const share = {
          handle: `kvh-${++nextHandle}`, prefix, access: o.access, owner: acct, holderAcct,
          holder: name, label, createdAt: Math.floor(Date.now() / 1000), revokedAt: null, revokedBy: null,
        };
        shares.set(share.handle, share);
        for (const sub of holderAcct.subs) {
          if (sub.subject !== 'notif:app-user') continue;
          const notification = { type: 'kv.share.received', handle: share.handle, access: share.access, label, createdAt: share.createdAt };
          deliver(holderAcct, sub, { id: `ev-${++nextEvent}`, op: 'post', type: notification.type, notification, self: true });
        }
        return shareRecord(share);
      },
      async unshare(handle) {
        if (!handle) fail('invalid_request');
        const share = shares.get(handle);
        if (!share || (share.owner !== acct && share.holderAcct !== acct)) fail('subject_does_not_exist');
        if (!share.revokedAt) {
          share.revokedAt = Math.floor(Date.now() / 1000) || 1;
          share.revokedBy = share.owner === acct ? 'owner' : 'holder';
        }
        return { handle, revokedAt: share.revokedAt };
      },
      async listShared() {
        const items = [...shares.values()]
          .filter((s) => s.holderAcct === acct && !s.revokedAt)
          .map((s) => ({ handle: s.handle, access: s.access, appUid: APP_ID, label: s.label, createdAt: s.createdAt }));
        return { items };
      },
      async listSharedByMe() {
        const items = [...shares.values()].filter((s) => s.owner === acct).map((s) => ({
          ...shareRecord(s), revokedAt: s.revokedAt, revokedBy: s.revokedBy,
        }));
        return { items };
      },
    });

    mock.perms = {
      Resource: { KV_SHARE: 'kvShare' },
      requests: [],
      async request(resource, details = {}) {
        mock.perms.requests.push({ resource, details });
        let grant = null;
        if (resource === 'kvShare') {
          grant = { prefix: validPrefix(details.prefix), access: details.access || 'watch' };
        } else if (resource === 'permission') {
          const m = /^manage:kv-share-write:([^:]+):([^:]+):(.+)$/.exec(details.permission || '');
          if (m && m[1] === uuid && m[2] === APP_ID) grant = { prefix: validPrefix(m[3]), access: 'write' };
        }
        if (!grant?.prefix || !mock.perms.consent) return false;
        acct.consents.add(grant);
        return true;
      },
      consent,
    };

    mock.events = {
      async onLocal(subject, handler) {
        const sub = { subject, handler };
        acct.subs.add(sub);
        return { subId: `sub-${++nextEvent}`, subject, off: async () => { acct.subs.delete(sub); } };
      },
    };
  }

  function shareRecord(s) {
    return {
      handle: s.handle, prefix: s.prefix, access: s.access, appUid: APP_ID,
      holder: s.holder, label: s.label, createdAt: s.createdAt,
    };
  }

  return { puter: mock, kvMap: kv, fileMap: files, accountId, shares };
}

/** Resolves read URLs minted by any mock account. Live: re-reads on fetch. */
function installFetchMock() {
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.host !== 'api.puter.example') throw new Error(`Unmocked fetch: ${url}`);
    const files = drives.get(Number(u.searchParams.get('u')));
    const path = u.searchParams.get('path');
    if (!files || !files.has(path)) {
      return { ok: false, status: 404, text: async () => 'Not found' };
    }
    return { ok: true, status: 200, text: async () => files.get(path) };
  };
}

export function installMockPuter() {
  const { puter: mock, kvMap: kv, fileMap: files } = createMockPuter();
  installFetchMock();

  const storage = new Map();
  globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear(),
  };
  globalThis.window = globalThis.window || globalThis;
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
  // Node's navigator global is a read-only getter without onLine; give the
  // store one that says "online" so share syncs run.
  if (!globalThis.navigator?.onLine) {
    try {
      Object.defineProperty(globalThis, 'navigator', {
        value: { onLine: true }, configurable: true,
      });
    } catch {}
  }
  globalThis.location = globalThis.location || {
    origin: 'https://tasks.example', pathname: '/', hash: '',
  };

  globalThis.puter = mock;
  return {
    puter: mock,
    kvMap: kv,
    fileMap: files,
    reset() {
      kv.clear();
      files.clear();
      storage.clear();
    },
  };
}
