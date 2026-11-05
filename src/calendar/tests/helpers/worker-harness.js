/**
 * Test harness for the workers in src/workers: instantiates one the way the
 * Puter workers runtime would — a `router` global collecting routes, a `me`
 * global exposing the owner's own Puter resources — and lets tests call its
 * routes as plain HTTP, with or without a signed-in caller (`user`, which the
 * runtime only populates for puter.workers.exec() callers). Request/Response
 * are small local shims so the harness never depends on which fetch globals
 * the test environment ships.
 */
import { webcrypto } from 'node:crypto';
import { vi } from 'vitest';

/* ---- Minimal fetch-shape shims ---------------------------------------- */

class HeadersShim {
  constructor(init = {}) {
    this.m = new Map(Object.entries(init).map(([k, v]) => [k.toLowerCase(), String(v)]));
  }
  get(name) {
    const key = String(name).toLowerCase();
    return this.m.has(key) ? this.m.get(key) : null;
  }
}

class RequestShim {
  constructor(url, { method = 'GET', headers = {}, body } = {}) {
    this.url = String(url);
    this.method = method;
    this.headers = headers instanceof HeadersShim ? headers : new HeadersShim(headers);
    this._body = body;
  }
  async text() {
    return this._body == null ? '' : String(this._body);
  }
  async json() {
    return JSON.parse(await this.text());
  }
}

export class ResponseShim {
  constructor(body, { status = 200, headers = {} } = {}) {
    this._body = body;
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.headers = headers instanceof HeadersShim ? headers : new HeadersShim(headers);
  }
  async text() {
    return this._body == null ? '' : String(this._body);
  }
  async json() {
    return JSON.parse(await this.text());
  }
}

/* ---- Fake puter.kv (same shape the app tests use) ----------------------- */

export function makeKv(initial = {}) {
  const map = new Map(Object.entries(initial));
  const globToRe = (glob) =>
    new RegExp('^' + glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return {
    map,
    set: vi.fn(async (k, v) => {
      const items = Array.isArray(k) ? k : [{ key: k, value: v }];
      for (const { key, value } of items) map.set(key, JSON.parse(JSON.stringify(value)));
      return true;
    }),
    get: vi.fn(async (k) => (map.has(k) ? map.get(k) : null)),
    del: vi.fn(async (k) => {
      map.delete(k);
      return true;
    }),
    incr: vi.fn(async (k, by = 1) => {
      const next = (Number(map.get(k)) || 0) + by;
      map.set(k, next);
      return next;
    }),
    // Expiry is a no-op here: tests assert that a TTL was requested, never
    // that the key vanished (nothing in a test runs long enough for that).
    expire: vi.fn(async () => true),
    list: vi.fn(async (pattern, returnValues) => {
      let keys = [...map.keys()];
      if (typeof pattern === 'string') keys = keys.filter((k) => globToRe(pattern).test(k));
      return returnValues ? keys.map((k) => ({ key: k, value: map.get(k) })) : keys;
    }),
  };
}

/* ---- Worker instantiation ------------------------------------------------ */

export async function sha256Hex(text) {
  const buf = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function matchRoute(routes, method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const pSegs = r.pattern.split('/').filter(Boolean);
    const uSegs = pathname.split('/').filter(Boolean);
    if (pSegs.length !== uSegs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pSegs.length; i++) {
      if (pSegs[i].startsWith(':')) params[pSegs[i].slice(1)] = decodeURIComponent(uSegs[i]);
      else if (pSegs[i] !== uSegs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

/**
 * Run worker source (placeholders already substituted) and return a `call`
 * able to hit its routes. `kv` is the worker-owner's storage; `me` overrides
 * the whole owner context for a worker that uses more of it than storage
 * (e.g. the email worker's `me.puter.email` / `me.puter.authToken`).
 */
export function instantiateWorker(source, { kv = makeKv(), me = { puter: { kv } } } = {}) {
  const routes = [];
  const add = (method) => (pattern, handler) => routes.push({ method, pattern, handler });
  const router = {
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    delete: add('DELETE'),
    options: add('OPTIONS'),
  };
  new Function('router', 'me', 'crypto', 'Response', `'use strict';\n${source}`)(
    router,
    me,
    webcrypto,
    ResponseShim,
  );

  /** `user` stands in for the caller context the runtime attaches when the
   *  request arrives through puter.workers.exec(); omit it to call as an
   *  anonymous visitor. `bindAs` picks the property it arrives on — the
   *  runtime has used both `user` and `requestor`. */
  async function call(
    method,
    pathAndQuery,
    { headers = {}, body, json, user = null, bindAs = 'user', waitUntil = null } = {},
  ) {
    const init = { method, headers: { ...headers } };
    if (json !== undefined) {
      init.body = JSON.stringify(json);
      init.headers['content-type'] = 'application/json';
    } else if (body !== undefined) {
      init.body = body;
      if (!init.headers['content-type']) {
        init.headers['content-type'] = 'application/x-www-form-urlencoded';
      }
    }
    const url = new URL(pathAndQuery, 'https://test-worker.puter.work');
    const match = matchRoute(routes, method, url.pathname);
    if (!match) return new ResponseShim('no route', { status: 404 });
    const request = new RequestShim(url.href, init);
    const ctx = { request, params: match.params, me };
    if (user) ctx[bindAs] = user;
    // The runtime hands routes the FetchEvent, which has waitUntil.
    if (waitUntil) ctx.waitUntil = waitUntil;
    const result = await match.handler(ctx);
    return result instanceof ResponseShim
      ? result
      : new ResponseShim(JSON.stringify(result), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
  }

  return { call, kv, me, routes };
}

/**
 * A fake `puter` global for the client module: fs.write stores files,
 * workers.create instantiates the written source as a live worker, and
 * fetch requests can be bridged to it with `bridgeFetch`.
 */
export function makeFakePuter() {
  const files = new Map();
  const workersByUrl = new Map();
  const created = [];
  return {
    files,
    created,
    workersByUrl,
    fs: {
      write: vi.fn(async (path, content) => {
        files.set(path, content);
        // Overwriting a deployed worker's file redeploys it (Puter semantics).
        for (const w of workersByUrl.values()) {
          if (w.filePath === path) w.instance = instantiateWorker(content, { kv: w.instance.kv });
        }
        return true;
      }),
    },
    workers: {
      create: vi.fn(async (name, filePath) => {
        const url = `https://${name}.puter.work`;
        const instance = instantiateWorker(files.get(filePath));
        workersByUrl.set(url, { name, filePath, instance });
        created.push(name);
        return { url };
      }),
      get: vi.fn(async (name) => {
        for (const w of workersByUrl.values()) if (w.name === name) return { file_path: w.filePath };
        throw new Error('no such worker');
      }),
    },
  };
}

/** A fetch() stand-in that routes requests to the fake puter's live workers. */
export function bridgeFetch(fakePuter) {
  return async (url, init = {}) => {
    const u = new URL(url);
    const worker = fakePuter.workersByUrl.get(u.origin);
    if (!worker) return new ResponseShim('no worker at ' + u.origin, { status: 502 });
    return worker.instance.call(init.method || 'GET', u.pathname + u.search, {
      headers: init.headers || {},
      body: init.body,
    });
  };
}
