/**
 * A fake Puter for the review feature: just the surface the app and the
 * review worker use, with the rules that matter for security kept honest.
 *
 *   world.sdk(user)        what `puter` is in that person's browser tab: auth,
 *                          their app KV, their files (relative paths land in
 *                          /<user>/AppData/video-studio/), read links, workers
 *   workers.create(name)   records a worker owned by the caller at https://<name>.puter.work
 *   workers.exec(url)      runs the real worker code (worker/http.js) in this
 *                          page: me.puter is the owner's app (same KV and
 *                          files as the owner's app, as a worker deployed from
 *                          an app is bound to it); user.puter is built from the
 *                          request's puter-auth header, so a restricted read
 *                          token can only stat and read its one file
 *   fs.getReadURL(path)    mints an access token for that one file (20 an hour
 *                          per person, like Puter), answered by
 *                          answerTokenRead() in tests or the harness's service
 *                          worker in the browser, with Range support
 *
 * Not modelled: Puter's own latency and outages, storage quotas, the real
 * token format (tokens here are unsigned), and kv.list (deliberately absent).
 */
import { memoryStorage, answerTokenRead, parseTokenRead } from './fake-store.js';
import { health, handleApi } from '../worker/http.js';
import { ReviewService } from '../worker/service.js';
import { resetAuthCache } from '../worker/auth.js';

export const USERS = {
  alice: { uuid: '11111111-1111-4111-8111-111111111111', username: 'alice' },
  bob: { uuid: '22222222-2222-4222-8222-222222222222', username: 'bob' },
  carol: { uuid: '33333333-3333-4333-8333-333333333333', username: 'carol' },
  dave: { uuid: '44444444-4444-4444-8444-444444444444', username: 'dave' },
};

export const API_ORIGIN = 'https://api.puter.mock';
const APP = 'video-studio';
const MINTS_PER_HOUR = 20;

const b64url = (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const packUuid = (uuid) => b64url(String.fromCharCode(...uuid.replace(/-/g, '').match(/../g).map((h) => parseInt(h, 16))));
const rand = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);

function puterError(message, code, status) {
  return Object.assign(new Error(message), { code, status });
}

/** Seconds from a jsonwebtoken style duration ("4h", "24h", 3600). */
export function durationSeconds(v) {
  if (typeof v === 'number') return v;
  const m = /^(\d+)\s*([smhdwy]?)$/.exec(String(v).trim());
  if (!m) throw puterError('Invalid expiresIn', 'bad_request', 400);
  return Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 }[m[2]];
}

export function createWorld({ storage = memoryStorage(), now = () => Date.now(), latency = 0, workerBuild = 'dev' } = {}) {
  const wait = () => (latency ? new Promise((r) => setTimeout(r, latency * (0.5 + Math.random()))) : Promise.resolve());
  const services = new Map(); // worker host -> ReviewService (one warm instance per page, like a worker isolate)
  const world = { storage, now, calls: [], offline: false };

  const sessionToken = (user) => `hdr.${b64url(JSON.stringify({ t: 'au', v: '2', uu: packUuid(user.uuid), app: APP }))}.sig`;

  function resolvePath(user, path) {
    const p = String(path);
    if (p.startsWith('/')) {
      if (!p.startsWith(`/${user.username}/`)) throw puterError('Permission denied', 'forbidden', 403);
      return p;
    }
    return `/${user.username}/AppData/${APP}/${p.replace(/^\.?\//, '')}`;
  }

  /** A person's app KV (the worker deployed from the app shares it). */
  function kvFor(user) {
    const k = (key) => `${user.uuid}:${APP}:${key}`;
    const live = (rec) => (rec && (!rec.exp || rec.exp > world.now()) ? rec : null);
    const one = async (key) => structuredClone(live(await storage.get('kv', k(key)))?.v ?? null);
    return {
      async get(key) {
        await wait();
        if (Array.isArray(key)) return Promise.all(key.map(one));
        return one(key);
      },
      async set(key, value, options = {}) {
        await wait();
        const size = JSON.stringify(value ?? null).length;
        if (size > 400 * 1024) throw puterError('Value too large', 'value_too_large', 400);
        if (options?.onlyIfAbsent) {
          let written = false;
          await storage.update('kv', k(key), (cur) => {
            if (live(cur)) return cur;
            written = true;
            return { v: structuredClone(value) };
          });
          return written;
        }
        await storage.put('kv', k(key), { v: structuredClone(value) });
        return true;
      },
      // The review service uses flat field updates. Like Puter's update(), these
      // preserve unrelated fields and run atomically, including across dev tabs.
      async update(key, fields) {
        await wait();
        if (!fields || !Object.keys(fields).length || Object.keys(fields).some((path) => !/^[a-zA-Z_$][\w$]*$/.test(path))) {
          throw puterError('The fake supports nonempty flat field updates only', 'bad_request', 400);
        }
        const values = structuredClone(fields);
        const rec = await storage.update('kv', k(key), (cur) => {
          const c = live(cur);
          return { v: { ...c?.v, ...values }, ...(c?.exp ? { exp: c.exp } : {}) };
        });
        return structuredClone(rec.v);
      },
      async del(key) {
        await wait();
        await storage.del('kv', k(key));
        return true;
      },
      async incr(key, amount = 1) {
        await wait();
        const fields = amount && typeof amount === 'object' ? Object.entries(amount) : null;
        if (fields && (!fields.length || fields.some(([path, delta]) => !/^[a-zA-Z_$][\w$]*$/.test(path) || typeof delta !== 'number' || !Number.isFinite(delta)))) {
          throw puterError('The fake supports finite increments of flat fields only', 'bad_request', 400);
        }
        const rec = await storage.update('kv', k(key), (cur) => {
          const c = live(cur);
          let v;
          if (fields) {
            v = { ...c?.v };
            for (const [path, delta] of fields) v[path] = (Number(v[path]) || 0) + delta;
          } else v = (Number(c?.v) || 0) + amount;
          return { v, ...(c?.exp ? { exp: c.exp } : {}) };
        });
        return structuredClone(rec.v);
      },
      async expire(key, seconds) {
        await storage.update('kv', k(key), (cur) => (cur ? { ...cur, exp: world.now() + seconds * 1000 } : undefined));
        return true;
      },
    };
  }

  async function mint(user, path, expiresIn) {
    const file = await storage.get('files', path);
    if (!file) throw puterError('Not found', 'subject_does_not_exist', 404);
    const hour = world.now() - 3_600_000;
    const recent = ((await storage.get('mints', user.uuid)) || []).filter((t) => t > hour);
    if (recent.length >= MINTS_PER_HOUR) throw puterError('Too many requests', 'rate_limited', 429);
    await storage.put('mints', user.uuid, [...recent, world.now()]);
    const exp = Math.floor(world.now() / 1000) + durationSeconds(expiresIn ?? '24h');
    const token = `hdr.${b64url(JSON.stringify({ t: 't', v: '2', uu: packUuid(user.uuid), exp, n: rand() }))}.sig`;
    await storage.put('tokens', token, { user, uid: file.uid, path, exp, revoked: false });
    return `${API_ORIGIN}/token-read?uid=${encodeURIComponent(file.uid)}&token=${encodeURIComponent(token)}`;
  }

  const statOf = (file, caller) => ({
    uid: file.uid, path: file.path, name: file.name, size: file.blob.size, is_dir: false, modified: file.modified,
    owner: { username: file.owner.username },
    // Puter reports is_shared:null for a file the caller does not own.
    is_shared: file.owner.uuid === caller.uuid ? false : null,
  });

  function fsFor(user) {
    return {
      async write(path, data, opts = {}) {
        await wait();
        const full = resolvePath(user, path);
        const existing = await storage.get('files', full);
        if (existing && opts.overwrite === false) throw puterError('Item already exists', 'item_with_same_name_exists', 409);
        const blob = data instanceof Blob ? data : new Blob([typeof data === 'string' ? data : JSON.stringify(data)]);
        const name = full.split('/').pop();
        const file = { uid: existing?.uid || `f-${rand()}`, path: full, name, blob, mime: blob.type || '', owner: user, modified: world.now() };
        await storage.put('files', full, file);
        return { uid: file.uid, path: full, name, size: blob.size, is_dir: false };
      },
      async read(path) {
        await wait();
        const file = await storage.get('files', resolvePath(user, path));
        if (!file) throw puterError('Item does not exist', 'subject_does_not_exist', 404);
        return file.blob;
      },
      async stat(path) {
        await wait();
        const file = await storage.get('files', resolvePath(user, path));
        if (!file) throw puterError('Item does not exist', 'subject_does_not_exist', 404);
        return statOf(file, user);
      },
      async delete(path) {
        await wait();
        const full = resolvePath(user, path);
        for (const key of await storage.keys('files')) if (key === full || key.startsWith(`${full}/`)) await storage.del('files', key);
      },
      async readdir(path) {
        await wait();
        const dir = `${resolvePath(user, path).replace(/\/$/, '')}/`;
        const names = new Map();
        for (const key of await storage.keys('files')) {
          if (!key.startsWith(dir)) continue;
          const [first, ...rest] = key.slice(dir.length).split('/');
          if (!names.has(first)) names.set(first, rest.length > 0 ? null : await storage.get('files', key));
        }
        if (!names.size) throw puterError('Item does not exist', 'subject_does_not_exist', 404);
        return [...names].map(([name, f]) => ({ name, is_dir: !f, modified: f?.modified || 0, size: f?.blob.size || 0 }));
      },
      async getReadURL(path, expiresIn) {
        await wait();
        return mint(user, resolvePath(user, path), expiresIn);
      },
      async revokeReadURL(url) {
        const token = new URL(url, API_ORIGIN).searchParams.get('token');
        await storage.update('tokens', token, (t) => (t && t.user.uuid === user.uuid ? { ...t, revoked: true } : t ?? undefined));
      },
    };
  }

  /** user.puter inside a worker route, for a request carrying a restricted read token. */
  async function requestor(token) {
    const t = token ? await storage.get('tokens', token) : null;
    const usable = () => {
      if (!t || t.revoked || t.exp * 1000 <= world.now()) throw puterError('Token authentication failed', 'token_auth_failed', 401);
    };
    const only = async (path) => {
      usable();
      const file = await storage.get('files', path);
      if (!file || file.uid !== t.uid) throw puterError('Permission denied', 'forbidden', 403);
      return file;
    };
    const refused = async () => {
      throw puterError('Access tokens are not allowed to access this resource', 'forbidden', 403);
    };
    return {
      authToken: token,
      auth: { getUser: refused },
      kv: { get: refused, set: refused, incr: refused, del: refused },
      fs: {
        stat: async (path) => statOf(await only(path), t.user),
        read: async (path) => (await only(path)).blob,
        write: refused,
        getReadURL: refused,
      },
    };
  }

  function serviceFor(host, owner) {
    if (!services.has(host)) services.set(host, new ReviewService(world.workerPuter(owner), { now: world.now }));
    return services.get(host);
  }

  /** me.puter of a worker deployed by owner from this app. */
  world.workerPuter = (owner) => ({ kv: kvFor(owner), fs: fsFor(owner), auth: { getUser: async () => ({ ...owner }) } });

  world.sdk = (user, { signedIn = true } = {}) => {
    let signed = signedIn;
    const sdk = {
      env: 'web',
      APIOrigin: API_ORIGIN,
      get authToken() {
        return signed ? sessionToken(user) : null;
      },
      auth: {
        isSignedIn: () => signed,
        async getUser() {
          if (!signed) throw puterError('Not signed in', 'unauthorized', 401);
          return { ...user, email_confirmed: true };
        },
        async signIn() {
          signed = true;
          return { ...user };
        },
        async signOut() {
          signed = false;
        },
        async getProfilePicture() {
          return null;
        },
      },
      kv: kvFor(user),
      fs: fsFor(user),
      ui: {},
      workers: {
        async create(name, path) {
          await wait();
          if (await storage.get('workers', name)) throw puterError(`A worker named ${name} already exists`, 'conflict', 409);
          if (!(await storage.get('files', resolvePath(user, path)))) throw puterError('Worker file not found', 'subject_does_not_exist', 404);
          const url = `https://${name}.puter.work`;
          await storage.put('workers', name, { name, url, owner: user, path: resolvePath(user, path) });
          return { name, url };
        },
        async exec(url, init = {}) {
          await wait();
          if (world.offline) throw new TypeError('Failed to fetch');
          const req = new Request(url, init);
          if (!req.headers.get('puter-auth') && !req.headers.get('x-puter-no-auth')) req.headers.set('puter-auth', sdk.authToken || '');
          req.headers.delete('x-puter-no-auth');
          const u = new URL(req.url);
          const worker = await storage.get('workers', u.hostname.split('.')[0]);
          if (!worker || worker.url !== u.origin) return new Response('Not found', { status: 404 });
          if (u.pathname === '/health' && req.method === 'GET') return health(workerBuild, 0);
          if (u.pathname !== '/api' || req.method !== 'POST') return new Response('Not found', { status: 404 });
          const token = req.headers.get('puter-auth');
          const body = await req.clone().text();
          let op = null;
          try {
            op = JSON.parse(body).op;
          } catch {
            /* the worker answers it */
          }
          world.calls.push({ user: user.username, op, host: u.hostname });
          return handleApi({ request: req, user: token ? { puter: await requestor(token) } : null }, null, { service: serviceFor(u.hostname, worker.owner) });
        },
      },
    };
    return sdk;
  };

  /** What a browser would get loading a read link (tests). */
  world.fetchReadURL = async (url, { range } = {}) => {
    const parsed = parseTokenRead(url, API_ORIGIN);
    if (!parsed) return new Response('Not found', { status: 404 });
    return answerTokenRead(storage, parsed, range, world.now());
  };

  /** Forget per-page caches (as when a worker restarts). */
  world.restartWorkers = () => {
    services.clear();
    resetAuthCache();
  };

  return world;
}
