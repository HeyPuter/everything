// In-memory Puter for collaboration tests: KV with events, files, restricted
// read tokens, workers.exec routed to a RoomService, and a fake peer service.
// Ported from the Whiteboard app's collaboration test helpers.
import { RoomService, type WorkerPuter } from '../src/collab/server/service';
import { authenticate } from '../src/collab/server/auth';
import type { CollabPuter } from '../src/collab/puter-types';
import type { PeerApi, PeerConnection, PeerServer } from '../src/collab/peers';

export type User = { uuid: string; username: string };
export const owner: User = { uuid: '11111111-1111-4111-8111-111111111111', username: 'alice' };
export const editor: User = { uuid: '22222222-2222-4222-8222-222222222222', username: 'bob' };
export const viewer: User = { uuid: '33333333-3333-4333-8333-333333333333', username: 'cam' };
export const commenter: User = { uuid: '44444444-4444-4444-8444-444444444444', username: 'dee' };

class Target extends EventTarget {
  emit(type: string, properties: Record<string, unknown> = {}) {
    this.dispatchEvent(Object.assign(new Event(type), properties));
  }
}

export function createPeerHub() {
  const servers = new Map<string, Target & { inviteCode: string; close(): void }>();
  const stats = { sends: 0 };
  class Connection extends Target {
    connected = false;
    closed = false;
    dropped = false;
    other!: Connection;
    channels = new Map<number, { onmessage?: ((e: { data: unknown }) => void) | null }>();
    peerconnection = {
      localDescription: null as { sdp: string } | null,
      remoteDescription: null as { sdp: string } | null,
      createDataChannel: (_: string, options: RTCDataChannelInit) => {
        const channel = {
          readyState: 'open',
          bufferedAmount: 0,
          onmessage: null as ((e: { data: unknown }) => void) | null,
          close() {
            this.readyState = 'closed';
          },
          send: (data: string) => {
            stats.sends++;
            queueMicrotask(() => {
              if (!this.closed && !this.dropped) this.other.channels.get(options.id!)?.onmessage?.({ data });
            });
          },
        };
        this.channels.set(options.id!, channel);
        return channel;
      },
    };
    send(data: string) {
      stats.sends++;
      queueMicrotask(() => {
        if (!this.closed && !this.dropped) this.other.emit('message', { data });
      });
    }
    drop() {
      this.dropped = this.other.dropped = true;
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.connected = false;
      this.emit('close');
      if (!this.dropped) this.other.close();
    }
  }
  const connections: Connection[] = [];
  const peer: PeerApi = {
    async serve() {
      const server = Object.assign(new Target(), { inviteCode: crypto.randomUUID(), close: () => {} });
      server.close = () => {
        servers.delete(server.inviteCode);
        server.emit('close');
      };
      servers.set(server.inviteCode, server);
      return server as unknown as PeerServer;
    },
    async connect(code: string) {
      const server = servers.get(code);
      if (!server) throw new Error('no_host');
      const a = new Connection(),
        b = new Connection();
      a.other = b;
      b.other = a;
      connections.push(a, b);
      const [fa, fb] = [crypto.randomUUID(), crypto.randomUUID()].map((id) => ({ sdp: `v=0\r\na=fingerprint:sha-256 ${id}\r\n` }));
      Object.assign(a.peerconnection, { localDescription: fa, remoteDescription: fb });
      Object.assign(b.peerconnection, { localDescription: fb, remoteDescription: fa });
      setTimeout(() => {
        server.emit('connection', { conn: b });
        a.connected = b.connected = true;
        a.emit('open');
        b.emit('open');
      }, 0);
      return a as unknown as PeerConnection;
    },
  };
  return { stats, peer, connections };
}

type Listener = { subject: string; fn: (payload: { event: { key: string; ts: number; value?: unknown } }) => void; includeValue: boolean };

export function environment() {
  const data = new Map<string, unknown>(),
    files = new Map<string, string>(),
    fileInfo = new Map<string, { owner: { username: string } }>(),
    credentials = new Map<string, { user: User; path: string; revoked?: boolean }>(),
    handles = new Map<string, string>(),
    listeners = new Map<string, Listener>(),
    calls: Record<string, unknown>[] = [];
  const env = {
    data,
    files,
    calls,
    credentials,
    offline: false,
    // Users whose requests fail as if offline.
    offlineUsers: new Set<string>(),
    dropEvents: false,
    now: Date.now(),
    // Puter's handle routes: `refuse` answers mints with that error code; `mints` and `revoked` record calls.
    refuse: null as string | null,
    mints: [] as string[],
    revoked: [] as string[],
    service: undefined as unknown as RoomService,
    route: undefined as ((user: User) => RoomService | undefined) | undefined,
    sdk: undefined as unknown as (user: User) => CollabPuter,
    hub: createPeerHub(),
  };
  const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));
  const kv: WorkerPuter['kv'] & { expiries: Map<string, number> } = {
    expiries: new Map(),
    async get(key: string) {
      return clone(data.get(key) ?? null);
    },
    async incr(key: string, amount = 1) {
      const value = ((data.get(key) as number) || 0) + amount;
      data.set(key, value);
      return value;
    },
    async set(key: string, value: unknown, expireAt?: number) {
      data.set(key, clone(value));
      if (expireAt) kv.expiries.set(key, expireAt);
      if (!env.dropEvents)
        for (const { subject, fn, includeValue } of listeners.values()) {
          const direct = subject === `kv:app-photo:${key}`;
          const handle = [...handles].find(([h, prefix]) => subject === `kv:${h}:signal` && key === prefix + 'signal');
          if (direct || handle) queueMicrotask(() => fn({ event: { key, ts: env.now, ...(includeValue ? { value: clone(value) } : {}) } }));
        }
      return true;
    },
    async del(key: string) {
      data.delete(key);
      return true;
    },
    async list({ pattern, cursor, limit, returnValues }: { pattern: string; returnValues?: boolean; limit?: number; cursor?: string }) {
      const keys = [...data.keys()].filter((k) => k.startsWith(pattern.replace(/\*$/, ''))).sort();
      const at = Number(cursor || 0),
        end = at + Math.min(limit ?? 1000, 3);
      return { items: keys.slice(at, end).map((key) => (returnValues ? { key, value: clone(data.get(key)) } : key)), cursor: end < keys.length ? String(end) : undefined };
    },
  };
  const fsFor = (user: User) => ({
    async write(path: string, value: string | Blob) {
      files.set(path, typeof value === 'string' ? value : await value.text());
      fileInfo.set(path, { owner: { username: user.username } });
      return { path };
    },
    async read(path: string) {
      if (!files.has(path)) throw new Error('Missing file: ' + path);
      return new Blob([files.get(path)!]);
    },
    async stat(path: string) {
      if (!files.has(path)) throw new Error('Missing file: ' + path);
      return { path, size: new TextEncoder().encode(files.get(path)).length, is_shared: fileInfo.get(path)!.owner.username === user.username ? false : null, ...fileInfo.get(path) };
    },
    async getReadURL(path: string) {
      if (!files.has(path)) throw new Error('Missing file: ' + path);
      const token = 'header.' + btoa(JSON.stringify({ type: 'access-token', user_uid: user.uuid, token_uid: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + 86400 })) + '.signature';
      credentials.set(token, { user, path });
      return `https://api.puter.test/token-read?uid=proof&token=${encodeURIComponent(token)}`;
    },
  });
  const workerPuter: WorkerPuter = {
    kv,
    fs: fsFor(owner),
    auth: { getUser: async () => owner },
    APIOrigin: 'https://api.puter.test',
    authToken: 'header.' + btoa(JSON.stringify({ app_uid: 'app-photo' })) + '.signature',
  };
  const fetcher = (async (url: string, options: RequestInit) => {
    if (options.method === 'DELETE') {
      const handle = decodeURIComponent(String(url).split('/').pop()!);
      env.revoked.push(handle);
      handles.delete(handle);
      return Response.json({ handle, revokedAt: Math.floor(env.now / 1000) });
    }
    const { granteeUid, prefix } = JSON.parse(String(options.body));
    env.mints.push(granteeUid);
    if (env.refuse) return Response.json({ message: 'Refused', code: env.refuse }, { status: 403 });
    const handle = 'handle-' + granteeUid;
    handles.set(handle, prefix);
    return Response.json({ handle });
  }) as unknown as typeof fetch;
  const service = new RoomService(workerPuter, { now: () => env.now, fetcher, rooms: new Map() });
  env.service = service;
  /** Another worker instance (its own loaded rooms) over the same storage. */
  const instance = () => new RoomService(workerPuter, { now: () => env.now, fetcher, rooms: new Map() });
  const requestor = (token: string) => {
    const credential = credentials.get(token);
    if (!credential) throw Object.assign(new Error('Invalid credential'), { status: 401 });
    const allowed = (path: string) => {
      if (credential.revoked) throw Object.assign(new Error('Revoked credential'), { status: 401 });
      if (path !== credential.path) throw Object.assign(new Error('Restricted credential'), { status: 403 });
    };
    const readOnly = fsFor(credential.user);
    return {
      auth: {
        getUser: async (): Promise<User> => {
          throw new Error('Access tokens are not allowed to access this resource');
        },
      },
      fs: {
        stat: async (path: string) => {
          allowed(path);
          return readOnly.stat(path);
        },
        read: async (path: string) => {
          allowed(path);
          return readOnly.read(path);
        },
      },
    };
  };
  env.sdk = (user: User): CollabPuter => {
    const prefix = user.uuid === owner.uuid ? '' : `account:${user.uuid}:`;
    return {
      APIOrigin: 'https://api.puter.test',
      authToken: 'header.' + btoa(JSON.stringify({ type: 'app-under-user', app_uid: 'app-photo', user_uid: user.uuid })) + '.signature',
      auth: { isSignedIn: () => true, signIn: async () => true, getUser: async () => user },
      kv: {
        get: (key: string) => kv.get(prefix + key),
        set: (key: string, value: unknown) => kv.set(prefix + key, value),
      },
      fs: fsFor(user),
      workers: {
        async create(name: string) {
          return { url: `https://${name}.puter.work` };
        },
        async exec(url: string, options: { method?: string; headers?: Record<string, string>; body?: string }) {
          if (env.offline || env.offlineUsers.has(user.uuid)) throw new Error('Network unavailable');
          if (url.endsWith('/health')) return Response.json({ ok: true, build: 'test' });
          const input = JSON.parse(options.body!);
          calls.push({ user: user.uuid, ...input });
          try {
            const identity = await authenticate(new Request(url, { method: options.method, headers: options.headers, body: options.body }), requestor(options.headers!['puter-auth']!) as never, input);
            const result = await (env.route?.(user) ?? service).call(identity, input);
            return Response.json(result);
          } catch (error) {
            const e = error as Error & { status?: number };
            return Response.json({ message: e.message }, { status: e.status || 500 });
          }
        },
      },
      events: {
        onLocal: async (subject: string, fn: Listener['fn'], options: { includeValue?: boolean } = {}) => {
          const key = crypto.randomUUID();
          listeners.set(key, { subject, fn, includeValue: !!options.includeValue });
          return { off: () => listeners.delete(key) };
        },
      },
      peer: env.hub.peer,
    };
  };
  return Object.assign(env, { instance, kv, workerPuter });
}

export const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** Wait until `check` holds (polling), failing after `timeout`. */
export async function until(check: () => boolean | Promise<boolean>, timeout = 3000, what = 'condition') {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await wait(5);
  }
}
