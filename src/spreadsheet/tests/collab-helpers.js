// In-memory Puter for co-authoring tests: KV with events, files, restricted read tokens, and workers.exec
// routed to a RoomService. Ported from the Whiteboard app's collaboration test helpers (via Photo Studio).
import { RoomService } from '../src/collab/server/service.js';
import { authenticate } from '../src/collab/server/auth.js';

export const owner = { uuid: '11111111-1111-4111-8111-111111111111', username: 'alice' };
export const editor = { uuid: '22222222-2222-4222-8222-222222222222', username: 'bob' };
export const viewer = { uuid: '33333333-3333-4333-8333-333333333333', username: 'cam' };
export const stranger = { uuid: '44444444-4444-4444-8444-444444444444', username: 'dee' };

export function environment() {
  const data = new Map(), files = new Map(), fileInfo = new Map(), credentials = new Map(), handles = new Map(), listeners = new Map();
  const calls = [];
  const env = { data, files, calls, credentials, offline: false, offlineUsers: new Set(), now: Date.now() };
  const clone = (v) => (v === undefined ? v : structuredClone(v));
  const kv = {
    async get(key) { return clone(data.get(key) ?? null); },
    async incr(key, amount = 1) { const value = (data.get(key) || 0) + amount; data.set(key, value); return value; },
    async set(key, value) {
      data.set(key, clone(value));
      for (const { subject, fn } of listeners.values()) {
        const direct = subject === `kv:app-sheet:${key}`;
        const handle = [...handles].find(([h, prefix]) => subject === `kv:${h}:signal` && key === `${prefix}signal`);
        if (direct || handle) queueMicrotask(() => fn({ event: { key, ts: env.now } }));
      }
      return true;
    },
    async del(key) { data.delete(key); return true; },
    async list({ pattern, cursor, limit, returnValues }) {
      const keys = [...data.keys()].filter((k) => k.startsWith(pattern.replace(/\*$/, ''))).sort();
      const at = Number(cursor || 0), end = at + Math.min(limit ?? 1000, 3);
      return { items: keys.slice(at, end).map((key) => (returnValues ? { key, value: clone(data.get(key)) } : key)), cursor: end < keys.length ? String(end) : undefined };
    },
  };
  const fsFor = (user) => ({
    async write(path, value) {
      files.set(path, typeof value === 'string' ? value : new Uint8Array(await value.arrayBuffer()));
      fileInfo.set(path, { owner: { username: user.username } });
      return { path };
    },
    async read(path) {
      if (!files.has(path)) throw new Error(`Missing file: ${path}`);
      return new Response(files.get(path));
    },
    async stat(path) {
      if (!files.has(path)) throw new Error(`Missing file: ${path}`);
      const value = files.get(path);
      return { path, size: typeof value === 'string' ? new TextEncoder().encode(value).length : value.length, is_shared: fileInfo.get(path).owner.username === user.username ? false : null, ...fileInfo.get(path) };
    },
    async getReadURL(path) {
      if (!files.has(path)) throw new Error(`Missing file: ${path}`);
      const token = `header.${btoa(JSON.stringify({ type: 'access-token', user_uid: user.uuid, token_uid: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + 86400 }))}.signature`;
      credentials.set(token, { user, path });
      return `https://api.puter.test/token-read?uid=proof&token=${encodeURIComponent(token)}`;
    },
  });
  const workerPuter = {
    kv, fs: fsFor(owner), auth: { getUser: async () => owner }, APIOrigin: 'https://api.puter.test',
    authToken: `header.${btoa(JSON.stringify({ app_uid: 'app-sheet' }))}.signature`,
  };
  const fetcher = async (_url, options) => {
    const { granteeUid, prefix } = JSON.parse(String(options.body));
    const handle = `handle-${granteeUid}`;
    handles.set(handle, prefix);
    return Response.json({ handle });
  };
  const service = new RoomService(workerPuter, { now: () => env.now, fetcher, rooms: new Map() });
  env.service = service;
  /** Another worker instance (its own loaded rooms) over the same storage. */
  env.instance = () => new RoomService(workerPuter, { now: () => env.now, fetcher, rooms: new Map() });
  const requestor = (token) => {
    const credential = credentials.get(token);
    if (!credential) throw Object.assign(new Error('Invalid credential'), { status: 401 });
    const allowed = (path) => {
      if (credential.revoked) throw Object.assign(new Error('Revoked credential'), { status: 401 });
      if (path !== credential.path) throw Object.assign(new Error('Restricted credential'), { status: 403 });
    };
    const readOnly = fsFor(credential.user);
    return {
      auth: { getUser: async () => { throw new Error('Access tokens are not allowed to access this resource'); } },
      fs: { stat: async (path) => { allowed(path); return readOnly.stat(path); }, read: async (path) => { allowed(path); return readOnly.read(path); } },
    };
  };
  env.sdk = (user) => {
    const prefix = user.uuid === owner.uuid ? '' : `account:${user.uuid}:`;
    return {
      APIOrigin: 'https://api.puter.test',
      authToken: `header.${btoa(JSON.stringify({ type: 'app-under-user', app_uid: 'app-sheet', user_uid: user.uuid }))}.signature`,
      auth: { isSignedIn: () => true, signIn: async () => true, getUser: async () => user },
      kv: { get: (key) => kv.get(prefix + key), set: (key, value) => kv.set(prefix + key, value) },
      fs: fsFor(user),
      workers: {
        async create(name) { return { url: `https://${name}.puter.work` }; },
        async exec(url, options = {}) {
          if (env.offline || env.offlineUsers.has(user.uuid)) throw new Error('Network unavailable');
          if (url.endsWith('/health')) return Response.json({ ok: true, build: 'test' });
          const input = JSON.parse(options.body);
          calls.push({ user: user.uuid, ...input });
          try {
            const identity = await authenticate(new Request(url, { method: options.method, headers: options.headers, body: options.body }), requestor(options.headers['puter-auth']), input);
            const result = await (env.route?.(user) ?? service).call(identity, input);
            return Response.json(result);
          } catch (error) {
            return Response.json({ message: error.message }, { status: error.status || 500 });
          }
        },
      },
      events: {
        onLocal: async (subject, fn) => {
          const key = crypto.randomUUID();
          listeners.set(key, { subject, fn });
          return { off: () => listeners.delete(key) };
        },
      },
    };
  };
  return Object.assign(env, { kv, workerPuter });
}

export const SERVER = 'https://spreadsheet-test.puter.work';
export const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** Wait until `check` holds (polling), failing after `timeout`. */
export async function until(check, timeout = 4000, what = 'condition') {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await wait(5);
  }
}
