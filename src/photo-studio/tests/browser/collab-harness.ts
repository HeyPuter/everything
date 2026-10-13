// Test harness for shared documents in the browser: the room worker service
// and Puter (KV, files, restricted tokens, worker requests, change events and
// peer links) run in the test process; each page gets a stand-in Puter.js
// that forwards to it. Only these tests load it (it replaces the Puter.js
// script through request routing); production never sees it.
import type { BrowserContext, Page } from '@playwright/test';
import { environment, type User } from '../collab-helpers';

export type Env = ReturnType<typeof environment>;

/** The page side of the stand-in Puter.js (serialized into the page). */
export function pagePuter(authToken: string) {
  const call = (method: string, ...args: unknown[]) => (window as unknown as { __collab(m: string, a: unknown[]): Promise<unknown> }).__collab(method, args);
  class T extends EventTarget {
    emit(type: string, props: Record<string, unknown> = {}) {
      this.dispatchEvent(Object.assign(new Event(type), props));
    }
  }
  type Channel = { readyState: string; bufferedAmount: number; onmessage: ((e: { data: unknown }) => void) | null; send(d: string): void; close(): void };
  type Conn = T & { connected: boolean; channels: Map<number, Channel>; send(d: string): void; close(): void; peerconnection: unknown };
  const conns = new Map<string, Conn>(),
    servers = new Map<string, T & { inviteCode: string; close(): void }>(),
    listeners = new Map<string, (p: unknown) => void>();
  const makeConn = (id: string, local: string, remote: string) => {
    const c = new T() as Conn;
    c.connected = false;
    c.channels = new Map();
    c.send = (d) => void call('peer.send', id, 0, d);
    c.close = () => {
      if (!conns.has(id)) return;
      conns.delete(id);
      c.connected = false;
      c.emit('close');
      void call('peer.close', id);
    };
    c.peerconnection = {
      localDescription: { sdp: local },
      remoteDescription: { sdp: remote },
      createDataChannel: (_: string, o: { id: number }) => {
        const ch: Channel = { readyState: 'open', bufferedAmount: 0, onmessage: null, send: (d) => void call('peer.send', id, o.id, d), close() {} };
        c.channels.set(o.id, ch);
        return ch;
      },
    };
    conns.set(id, c);
    return c;
  };
  const w = window as unknown as Record<string, unknown>;
  w.__collabEvent = (id: string, payload: unknown) => listeners.get(id)?.(payload);
  w.__peerEvent = (kind: string, d: { id: string; server?: string; local?: string; remote?: string; channel?: number; data?: string }) => {
    if (kind === 'connection') {
      const c = makeConn(d.id, d.local!, d.remote!);
      servers.get(d.server!)?.emit('connection', { conn: c });
      c.connected = true;
      c.emit('open');
    } else if (kind === 'open') {
      const c = conns.get(d.id);
      if (c) {
        c.connected = true;
        c.emit('open');
      }
    } else if (kind === 'message') {
      const c = conns.get(d.id);
      if (d.channel) c?.channels.get(d.channel)?.onmessage?.({ data: d.data });
      else c?.emit('message', { data: d.data });
    } else if (kind === 'close') {
      const c = conns.get(d.id);
      if (c) {
        conns.delete(d.id);
        c.connected = false;
        c.emit('close');
      }
    }
  };
  const never = () => new Promise(() => {});
  w.puter = {
    env: 'web',
    APIOrigin: 'https://api.puter.test',
    authToken,
    auth: { isSignedIn: () => true, signIn: async () => true, signOut() {}, getUser: () => call('auth.getUser') },
    kv: { get: (k: string) => call('kv.get', k), set: (k: string, v: unknown) => call('kv.set', k, v) },
    fs: {
      write: async (p: string, d: string | Blob) => call('fs.write', p, typeof d === 'string' ? d : await d.text()),
      read: async (p: string) => new Blob([(await call('fs.read', p)) as string]),
      getReadURL: (p: string) => call('fs.getReadURL', p),
    },
    workers: {
      create: (n: string, p: string) => call('workers.create', n, p),
      exec: async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
        const r = (await call('workers.exec', url, { method: init.method, headers: init.headers, body: init.body })) as { status: number; body: string };
        return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
      },
    },
    events: {
      onLocal: async (subject: string, fn: (p: unknown) => void, o?: unknown) => {
        const id = crypto.randomUUID();
        listeners.set(id, fn);
        await call('events.onLocal', id, subject, o);
        return { off: () => listeners.delete(id) };
      },
    },
    peer: {
      serve: async () => {
        const code = (await call('peer.serve')) as string;
        const s = Object.assign(new T(), { inviteCode: code, close: () => void call('peer.unserve', code) });
        servers.set(code, s);
        return s;
      },
      connect: async (code: string) => {
        const r = (await call('peer.connect', code)) as { id: string; local: string; remote: string };
        return makeConn(r.id, r.local, r.remote);
      },
    },
    ui: { showOpenFilePicker: never, showSaveFilePicker: never, showDirectoryPicker: never },
    ai: {},
  };
}

/** Peer links relayed through the test process. */
export function relay() {
  const servers = new Map<string, Page>();
  const ends = new Map<string, { page: Page; other: string }>();
  const send = (id: string, kind: string, d: Record<string, unknown>) => {
    const end = ends.get(id);
    if (end) void end.page.evaluate(([k, x]) => (window as unknown as { __peerEvent(k: string, x: unknown): void }).__peerEvent(k as string, x), [kind, { id, ...d }] as const).catch(() => {});
  };
  return {
    serve(page: Page) {
      const code = crypto.randomUUID();
      servers.set(code, page);
      return code;
    },
    unserve(code: string) {
      servers.delete(code);
    },
    connect(page: Page, code: string) {
      const host = servers.get(code);
      if (!host) throw new Error('no_host');
      const a = crypto.randomUUID(),
        b = crypto.randomUUID();
      const [fa, fb] = [crypto.randomUUID(), crypto.randomUUID()].map((x) => `v=0\r\na=fingerprint:sha-256 ${x}\r\n`);
      ends.set(a, { page, other: b });
      ends.set(b, { page: host, other: a });
      setTimeout(() => {
        void host.evaluate(([k, x]) => (window as unknown as { __peerEvent(k: string, x: unknown): void }).__peerEvent(k as string, x), ['connection', { id: b, server: code, local: fb, remote: fa }] as const).then(() => send(a, 'open', {}));
      }, 0);
      return { id: a, local: fa, remote: fb };
    },
    send(id: string, channel: number, data: string) {
      const end = ends.get(id);
      if (end) send(end.other, 'message', { channel, data });
    },
    close(id: string) {
      const end = ends.get(id);
      if (!end) return;
      ends.delete(id);
      send(end.other, 'close', {});
      ends.delete(end.other);
    },
  };
}

export async function person(env: Env, peers: ReturnType<typeof relay>, context: BrowserContext, user: User, path = '/') {
  const page = await context.newPage();
  const sdk = env.sdk(user);
  const builds = new Map<string, string>();
  await page.exposeFunction('__collab', async (method: string, args: unknown[]) => {
    const [a, b, c] = args as [string, unknown, unknown];
    switch (method) {
      case 'auth.getUser':
        return user;
      case 'kv.get':
        return sdk.kv.get(a);
      case 'kv.set':
        return sdk.kv.set(a, b);
      case 'fs.write':
        return sdk.fs.write(a, b as string);
      case 'fs.read':
        return env.files.get(a) ?? null;
      case 'fs.getReadURL':
        return sdk.fs.getReadURL(a);
      case 'workers.create': {
        const build = /photo-studio-worker build=([a-f0-9]+)/.exec(env.files.get(b as string) ?? '')?.[1] ?? '';
        builds.set(a, build);
        return sdk.workers.create(a, b as string);
      }
      case 'workers.exec': {
        if (a.endsWith('/health')) return { status: 200, body: JSON.stringify({ ok: true, build: [...builds.values()].at(-1) ?? /photo-studio-worker build=([a-f0-9]+)/.exec([...env.files.values()].find((f) => f.startsWith('/* photo-studio-worker')) ?? '')?.[1] }) };
        const res = await sdk.workers.exec(a, b as { method?: string; headers?: Record<string, string>; body?: string });
        return { status: res.status, body: await res.text() };
      }
      case 'events.onLocal':
        await sdk.events!.onLocal(b as string, (payload) => void page.evaluate(([id, p]) => (window as unknown as { __collabEvent(i: string, p: unknown): void }).__collabEvent(id as string, p), [a, payload] as const).catch(() => {}), c as { includeValue?: boolean });
        return true;
      case 'peer.serve':
        return peers.serve(page);
      case 'peer.unserve':
        return peers.unserve(a);
      case 'peer.connect':
        return peers.connect(page, a);
      case 'peer.send':
        return peers.send(a, b as number, c as string);
      case 'peer.close':
        return peers.close(a);
    }
    throw new Error(`Unknown stand-in Puter call ${method}`);
  });
  const token = 'header.' + Buffer.from(JSON.stringify({ type: 'app-under-user', app_uid: 'app-photo', user_uid: user.uuid })).toString('base64') + '.signature';
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ contentType: 'application/javascript', body: `(${pagePuter.toString()})(${JSON.stringify(token)});` }));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(path);
  await page.waitForFunction(() => !!window.photoStudio?.renderer, null, { timeout: 90_000 });
  return { page, errors };
}

