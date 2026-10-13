/**
 * Thumbnails and waveforms for the timeline and media library, decoded in a
 * worker and cached per file. Views ask for what is visible and redraw when
 * the 'thumb' / 'peaks' events arrive.
 */
import { Emitter } from '../lib/emitter.js';

const THUMB_H = 96;

export class MediaService extends Emitter {
  constructor(library) {
    super();
    this.library = library;
    this.worker = null;
    this.seq = 0;
    this.pending = new Map(); // id -> { resolve, reject, onPartial }
    this.strips = new Map(); // hash -> Map(quantKey -> ImageBitmap | 'pending')
    this.peakCache = new Map(); // hash -> Promise<{ rate, data }>
    this.posters = new Map(); // hash -> Promise<ImageBitmap|null>
    this.queue = []; // { asset, times }
    this.busy = 0;
    this.proxies = null; // ProxyManager: thumbnails decode a ready proxy, which is faster
  }

  /** File to decode pictures from: the proxy when one is ready, else the original. */
  async _pictureBlob(asset) {
    if (this.proxies?.isReady(asset)) {
      const b = await this.proxies.blob(asset).catch(() => null);
      if (b) return b;
    }
    return this.library.mediaBlob(asset);
  }

  _worker() {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('../workers/media-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const { id, ok, result, error, partial } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      if (partial) {
        p.onPartial?.(partial);
        return;
      }
      this.pending.delete(id);
      if (ok) p.resolve(result);
      else p.reject(new Error(error));
    };
    return this.worker;
  }

  _call(msg, onPartial) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onPartial });
      this._worker().postMessage({ ...msg, id });
    });
  }

  /** Quantization step (seconds) for a timeline zoom in px per second. */
  static stepFor(pxPerSec, thumbW) {
    const raw = thumbW / Math.max(1e-6, pxPerSec);
    const steps = [1 / 30, 1 / 15, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];
    return steps.find((s) => s >= raw) || 600;
  }

  /**
   * Best available thumbnail near source time sec, requesting it if needed.
   * Returns an ImageBitmap or null.
   */
  thumb(asset, sec, step) {
    if (asset.kind === 'image') return this.poster(asset, true);
    if (asset.kind !== 'video') return null;
    let strip = this.strips.get(asset.hash);
    if (!strip) {
      strip = new Map();
      this.strips.set(asset.hash, strip);
    }
    const q = Math.max(0, Math.round(sec / step) * step);
    const key = q.toFixed(3);
    const have = strip.get(key);
    if (have && have !== 'pending') return have;
    if (!have) {
      strip.set(key, 'pending');
      this._enqueue(asset, q, key);
    }
    // Fall back to the nearest frame we already have.
    let best = null;
    let bestD = Infinity;
    for (const [k, v] of strip) {
      if (v === 'pending') continue;
      const d = Math.abs(Number(k) - sec);
      if (d < bestD) {
        best = v;
        bestD = d;
      }
    }
    return best;
  }

  _enqueue(asset, sec, key) {
    let job = this.queue.find((j) => j.asset.hash === asset.hash && !j.started);
    if (!job) {
      job = { asset, items: [], started: false };
      this.queue.push(job);
    }
    job.items.push({ sec, key });
    clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => this._pump(), 16);
  }

  async _pump() {
    if (this.busy >= 2) return;
    const job = this.queue.find((j) => !j.started);
    if (!job) return;
    job.started = true;
    this.busy++;
    try {
      const blob = await this._pictureBlob(job.asset);
      const items = job.items.sort((a, b) => a.sec - b.sec);
      const strip = this.strips.get(job.asset.hash);
      await this._call({ op: 'thumbs', blob, times: items.map((i) => i.sec), height: THUMB_H }, ({ index, bitmap }) => {
        strip.set(items[index].key, bitmap);
        this.emit('thumb', { hash: job.asset.hash });
      });
    } catch {
      // Leave 'pending' markers so we do not retry a file that cannot be decoded.
    } finally {
      this.busy--;
      this.queue.splice(this.queue.indexOf(job), 1);
      if (this.queue.some((j) => !j.started)) this._pump();
    }
  }

  /** First frame (video) or the image itself, scaled for the media library. */
  poster(asset, sync = false) {
    let entry = this.posters.get(asset.hash);
    if (!entry) {
      entry = { value: null, promise: null };
      entry.promise = (async () => {
        const blob = asset.kind === 'video' ? await this._pictureBlob(asset) : await this.library.mediaBlob(asset);
        if (asset.kind === 'image') {
          const bmp = await createImageBitmap(blob, { resizeHeight: 240, resizeQuality: 'medium' });
          return bmp;
        }
        if (asset.kind !== 'video') return null;
        let first = null;
        const t = Math.min(1, (asset.duration || 0) / 2e6);
        await this._call({ op: 'thumbs', blob, times: [t], height: 240 }, ({ bitmap }) => (first = bitmap));
        return first;
      })()
        .catch(() => null)
        .then((v) => {
          entry.value = v;
          this.emit('poster', { hash: asset.hash });
          return v;
        });
      this.posters.set(asset.hash, entry);
    }
    return sync ? entry.value : entry.promise;
  }

  /** Waveform peaks { rate, data (min,max pairs), duration } for an asset with audio. */
  peaks(asset) {
    let p = this.peakCache.get(asset.hash);
    if (!p) {
      p = this.library
        .mediaBlob(asset)
        .then((blob) => this._call({ op: 'peaks', blob, rate: 100 }))
        .catch(() => ({ rate: 100, data: new Float32Array(0), duration: 0 }))
        .then((r) => {
          p.settled = true;
          p.value = r;
          this.emit('peaks', { hash: asset.hash });
          return r;
        });
      this.peakCache.set(asset.hash, p);
    }
    return p;
  }

  /** Synchronous access once peaks are loaded (null while loading). */
  peaksNow(asset) {
    const p = this.peakCache.get(asset.hash);
    if (!p) {
      this.peaks(asset);
      return null;
    }
    return p.settled ? p.value : null;
  }

  dispose() {
    this.worker?.terminate();
    for (const strip of this.strips.values()) for (const v of strip.values()) v?.close?.();
    this.strips.clear();
  }
}
