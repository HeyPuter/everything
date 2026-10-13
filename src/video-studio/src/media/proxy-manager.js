/**
 * Proxy media on this device: which videos have a proxy, making them one at
 * a time in a worker (media/proxy.js), and handing the preview a proxy's
 * file. See model/proxy.js for when a proxy is wanted and used.
 *
 * Proxies live in the local cache (OPFS, "video-studio-cache/proxies"), never
 * in the project's storage: they are quick to make again, would cost cloud
 * space and upload time on every device, and must never end up in an export
 * or a project file. The library is only read from (the original file).
 *
 * Status per content hash: 'queued', 'generating' (with progress), 'ready'
 * or 'error'; no entry means no proxy. Emits 'change' { hash } on every
 * status or progress change.
 *
 * Remembered per device (memory: { get(), set(v) }):
 *   skip  hashes whose proxy the user deleted (auto will not make it again)
 *   slow  hashes the preview struggled to decode (auto makes a proxy)
 */
import { Emitter } from '../lib/emitter.js';
import { opfsAvailable, opfsBackend, memoryBackend } from '../storage/backends.js';
import { PROXY_DIR, PROXY_VERSION, PROXY_SHORT, proxyMode, proxyPlan, wantsProxy, canProxy, isCurrentProxy, parseProxyName, durationTolerance } from '../model/proxy.js';

/** OPFS folder shared with the cloud media cache (storage/library.js). */
export const PROXY_ROOT = 'video-studio-cache';
const MAX_REMEMBERED = 300;

/** Encoder in a worker: generate({ blob, plan, base, tolerance, signal, onProgress }) -> { name, size, blob? }. */
export function workerGenerator({ root = PROXY_ROOT, dir = PROXY_DIR } = {}) {
  let worker = null;
  let seq = 0;
  const pending = new Map(); // id -> { resolve, reject, onProgress }
  const failAll = (msg) => {
    for (const p of pending.values()) p.reject(new Error(msg));
    pending.clear();
  };
  const get = () => {
    if (worker) return worker;
    worker = new Worker(new URL('../workers/proxy-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, ok, result, error, code, partial } = e.data;
      const p = pending.get(id);
      if (!p) return;
      if (partial) {
        p.onProgress?.(partial.progress);
        return;
      }
      pending.delete(id);
      if (ok) p.resolve(result);
      else p.reject(Object.assign(new Error(error), { code }));
    };
    worker.onerror = () => {
      failAll('The proxy encoder stopped.');
      worker?.terminate();
      worker = null;
    };
    return worker;
  };
  const generate = ({ blob, plan, base, tolerance, signal, onProgress }) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject, onProgress });
      get().postMessage({ id, op: 'proxy', blob, plan, root, dir, base, tolerance });
      signal?.addEventListener('abort', () => worker?.postMessage({ op: 'cancel', target: id }), { once: true });
    });
  generate.dispose = () => {
    failAll('Closed');
    worker?.terminate();
    worker = null;
  };
  return generate;
}

/** Encoder on the main thread (no workers): returns the proxy as a Blob. */
export function mainThreadGenerator() {
  return async ({ blob, plan, base, tolerance, signal, onProgress }) => {
    const [mb, { generateProxy, checkProxy }] = await Promise.all([import('mediabunny'), import('./proxy.js')]);
    const out = await generateProxy({ blob, plan, onProgress, signal, mb });
    await checkProxy(mb, out.blob, plan, tolerance);
    return { name: `${base}.${out.ext}`, size: out.blob.size, codec: out.codec, blob: out.blob };
  };
}

function inMemory() {
  let v = null;
  return { get: () => v, set: (x) => (v = x) };
}

export class ProxyManager extends Emitter {
  /**
   * library: reads original media. cache: storage backend for proxy files
   * (default OPFS). generate: the encoder (default a worker). memory: where
   * skip and slow lists persist.
   */
  constructor({ library, cache, generate, memory } = {}) {
    super();
    this.library = library;
    this.cache = cache || (opfsAvailable() ? opfsBackend(PROXY_ROOT) : memoryBackend());
    this.generate = generate || (typeof Worker === 'function' ? workerGenerator() : mainThreadGenerator());
    this.memory = memory || inMemory();
    this.entries = new Map(); // hash -> { state, progress, name, size, error, manual, ctrl }
    this.assets = new Map(); // hash -> asset, the latest seen
    this.queue = []; // hashes waiting
    this.urls = new Map(); // hash -> Promise<url>
    this.sessionSkip = new Set(); // deleted with "Delete all proxies": not made again this session
    this.running = null;
    this.disposed = false;
    const saved = this.memory.get() || {};
    this.skip = new Set(Array.isArray(saved.skip) ? saved.skip : []);
    this.slow = new Set(Array.isArray(saved.slow) ? saved.slow : []);
    this.ready = null;
  }

  /** Find the proxies already on this device and delete ones of an older format. */
  init() {
    this.ready ||= (async () => {
      const files = await this.cache.list(PROXY_DIR).catch(() => []);
      for (const f of files) {
        if (f.isDir) continue;
        const p = parseProxyName(f.name);
        if (!isCurrentProxy(f.name) || (f.size === 0 && this.cache.kind !== 'memory')) {
          await this.cache.remove(`${PROXY_DIR}/${f.name}`).catch(() => {});
          continue;
        }
        if (!this.entries.has(p.hash)) this.entries.set(p.hash, { state: 'ready', progress: 1, name: f.name, size: f.size });
      }
      this.emit('change', {});
    })();
    return this.ready;
  }

  _save() {
    const trim = (set) => [...set].slice(-MAX_REMEMBERED);
    this.memory.set({ skip: trim(this.skip), slow: trim(this.slow) });
  }

  /** { state: 'none'|'queued'|'generating'|'ready'|'error', progress, size, error } for an asset. */
  status(asset) {
    const e = asset?.hash ? this.entries.get(asset.hash) : null;
    if (!e) return { state: 'none', progress: 0, size: 0, error: null };
    return { state: e.state, progress: e.progress || 0, size: e.size || 0, error: e.error || null };
  }

  isReady(asset) {
    return this.entries.get(asset?.hash)?.state === 'ready';
  }

  isSlow(asset) {
    return Boolean(asset?.hash && this.slow.has(asset.hash));
  }

  /**
   * Bring the queue in line with a project: make the proxies its mode asks
   * for, and stop work on media the project no longer has or no longer
   * wants (explicit requests are kept while the media is in the project).
   */
  sync(project) {
    if (this.disposed) return;
    const mode = proxyMode(project);
    const present = new Map();
    for (const a of Object.values(project?.assets || {})) if (canProxy(a)) present.set(a.hash, a);
    for (const [hash, e] of this.entries) {
      if (e.state !== 'queued' && e.state !== 'generating') continue;
      const a = present.get(hash);
      if (!a || (!e.manual && !wantsProxy(a, mode, { slow: this.slow.has(hash) }))) this.cancel(hash);
    }
    for (const [hash, a] of present) {
      this.assets.set(hash, a);
      if (this.entries.has(hash) || this.skip.has(hash) || this.sessionSkip.has(hash)) continue;
      if (wantsProxy(a, mode, { slow: this.slow.has(hash) })) this._enqueue(a, false);
    }
  }

  /** Make a proxy for an asset now (the media menu). */
  create(asset) {
    if (!canProxy(asset)) return false;
    const hash = asset.hash;
    this.assets.set(hash, asset);
    const changed = this.skip.delete(hash);
    this.sessionSkip.delete(hash);
    if (changed) this._save();
    const e = this.entries.get(hash);
    if (e?.state === 'ready' || e?.state === 'generating') return true;
    if (e?.state === 'queued') {
      e.manual = true;
      return true;
    }
    this.entries.delete(hash);
    this._enqueue(asset, true);
    return true;
  }

  _enqueue(asset, manual) {
    this.entries.set(asset.hash, { state: 'queued', progress: 0, manual });
    this.queue.push(asset.hash);
    this.emit('change', { hash: asset.hash });
    queueMicrotask(() => this._pump());
  }

  /** Stop making a proxy (queued or in progress). */
  cancel(hash) {
    const e = this.entries.get(hash);
    if (!e || (e.state !== 'queued' && e.state !== 'generating')) return false;
    this.queue = this.queue.filter((h) => h !== hash);
    e.ctrl?.abort();
    this.entries.delete(hash);
    this.emit('change', { hash });
    return true;
  }

  async _pump() {
    if (this.running || this.disposed) return;
    let hash;
    while ((hash = this.queue.shift())) {
      if (this.entries.get(hash)?.state === 'queued') break;
    }
    if (!hash) return;
    const entry = this.entries.get(hash);
    const asset = this.assets.get(hash);
    const ctrl = new AbortController();
    Object.assign(entry, { state: 'generating', progress: 0, ctrl });
    this.running = entry;
    this.emit('change', { hash });
    let lastEmit = 0;
    try {
      const blob = await this.library.mediaBlob(asset);
      if (ctrl.signal.aborted) throw Object.assign(new Error('Canceled'), { code: 'canceled' });
      const plan = proxyPlan(asset);
      const res = await this.generate({
        blob,
        plan,
        base: `${hash}.v${PROXY_VERSION}.${PROXY_SHORT}`,
        tolerance: durationTolerance(plan),
        signal: ctrl.signal,
        onProgress: (p) => {
          entry.progress = p;
          const now = Date.now();
          if (now - lastEmit > 120) {
            lastEmit = now;
            this.emit('change', { hash });
          }
        },
      });
      if (ctrl.signal.aborted) throw Object.assign(new Error('Canceled'), { code: 'canceled' });
      if (!isCurrentProxy(res?.name)) throw new Error('The proxy encoder returned an unexpected file.');
      if (res.blob) await this.cache.writeBlob(`${PROXY_DIR}/${res.name}`, res.blob);
      Object.assign(entry, { state: 'ready', progress: 1, name: res.name, size: res.size || res.blob?.size || 0, ctrl: null });
    } catch (err) {
      if (ctrl.signal.aborted || err?.code === 'canceled') {
        if (this.entries.get(hash) === entry) this.entries.delete(hash);
      } else {
        Object.assign(entry, { state: 'error', error: err?.message || 'The proxy could not be made.', ctrl: null });
      }
    } finally {
      this.running = null;
      if (!this.disposed) {
        this.emit('change', { hash });
        this._pump();
      }
    }
  }

  /** The proxy file of an asset (a Blob), or null when it has none. */
  async blob(asset) {
    const e = this.entries.get(asset?.hash);
    if (e?.state !== 'ready') return null;
    return this.cache.readBlob(`${PROXY_DIR}/${e.name}`);
  }

  /** Object URL of an asset's proxy, created once. */
  url(asset) {
    const hash = asset.hash;
    let u = this.urls.get(hash);
    if (!u) {
      u = this.blob(asset).then((b) => {
        if (!b) throw new Error('Proxy missing');
        return URL.createObjectURL(b);
      });
      u.catch(() => this.urls.delete(hash));
      this.urls.set(hash, u);
    }
    return u;
  }

  _dropUrl(hash) {
    const u = this.urls.get(hash);
    this.urls.delete(hash);
    u?.then((url) => URL.revokeObjectURL(url)).catch(() => {});
  }

  /** Delete an asset's proxy (or stop making it); auto will not make it again on this device. */
  async remove(asset) {
    const hash = asset.hash;
    this.cancel(hash);
    const e = this.entries.get(hash);
    this.entries.delete(hash);
    this.skip.add(hash);
    this._save();
    this._dropUrl(hash);
    if (e?.name) await this.cache.remove(`${PROXY_DIR}/${e.name}`).catch(() => {});
    this.emit('change', { hash, removed: true });
  }

  /** Delete every proxy on this device. They are not made again until the next session. */
  async removeAll() {
    for (const hash of this.entries.keys()) this.sessionSkip.add(hash);
    for (const hash of [...this.entries.keys()]) this.cancel(hash);
    const files = await this.cache.list(PROXY_DIR).catch(() => []);
    for (const f of files) {
      const p = parseProxyName(f.name);
      if (p) this.sessionSkip.add(p.hash);
    }
    await this.cache.remove(PROXY_DIR).catch(() => {});
    for (const hash of [...this.urls.keys()]) this._dropUrl(hash);
    this.entries.clear();
    this.emit('change', { removed: true });
    return files.length;
  }

  /** Proxy files on this device and their total size in bytes. */
  async usage() {
    await this.init();
    const files = (await this.cache.list(PROXY_DIR).catch(() => [])).filter((f) => !f.isDir && isCurrentProxy(f.name));
    let bytes = 0;
    for (const f of files) bytes += f.size || this.entries.get(parseProxyName(f.name).hash)?.size || 0;
    return { files: files.length, bytes };
  }

  /** The preview could not keep up decoding this file: remember it so auto makes a proxy. */
  markSlow(asset) {
    if (!canProxy(asset) || this.slow.has(asset.hash)) return false;
    this.slow.add(asset.hash);
    this._save();
    this.emit('change', { hash: asset.hash, slow: true });
    return true;
  }

  dispose() {
    this.disposed = true;
    for (const hash of [...this.entries.keys()]) this.cancel(hash);
    for (const hash of [...this.urls.keys()]) this._dropUrl(hash);
    this.generate.dispose?.();
  }
}
