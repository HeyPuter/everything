/**
 * Thumbnails and waveforms for the timeline and media library, decoded in a
 * worker and cached per file. Views ask for what is visible and redraw when
 * the 'thumb' / 'peaks' events arrive.
 */
import { Emitter } from '../lib/emitter.js';

const THUMB_H = 96;
/** Thumbnails kept per video (about 65 KB each at this height). */
const THUMBS_KEPT = 600;
/** Times a file that could not be read is tried again on its own. */
const READ_RETRIES = 4;

export class MediaService extends Emitter {
  constructor(library) {
    super();
    this.library = library;
    this.worker = null;
    this.workerFailures = 0;
    this.retryTimers = new Set();
    this.seq = 0;
    this.pending = new Map(); // id -> { resolve, reject, onPartial }
    this.strips = new Map(); // hash -> Map(quantKey -> ImageBitmap | 'pending')
    this.peakCache = new Map(); // hash -> Promise<{ rate, data }>
    this.posters = new Map(); // hash -> Promise<ImageBitmap|null>
    this.queue = []; // { asset, times }
    this.busy = 0;
    this.proxies = null; // ProxyManager: thumbnails decode a ready proxy, which is faster
    this.missing = new Set(); // hashes of media whose file is not in storage ('missing' event when it changes)
    this.readFailures = new Map(); // hash -> reads that failed in a row
    this.mediaVersions = new Map(); // invalidates thumbnail jobs and their delayed retries
    this._offAvailable = library?.on?.('media-available', ({ hash }) => {
      const wasMissing = this.missing.delete(hash);
      this.forget(hash);
      if (wasMissing) this.emit('missing');
    });
  }

  /** File to decode pictures from: the proxy when one is ready, else the original. */
  async _pictureBlob(asset) {
    if (this.proxies?.isReady(asset)) {
      const b = await this.proxies.blob(asset).catch(() => null);
      if (b) return b;
    }
    return this._mediaBlob(asset);
  }

  /** The asset's file. A failed read is marked, to tell it from a file that cannot be decoded. */
  async _mediaBlob(asset) {
    try {
      const blob = await this.library.mediaBlob(asset);
      this.readFailures.delete(asset.hash);
      return blob;
    } catch (err) {
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { readFailed: asset.hash });
    }
  }

  /**
   * Drop what is remembered about a file that gave nothing (blank thumbnails, no poster, an
   * empty waveform), so it is read again: its file was found again or put back.
   */
  forget(hash) {
    if (this.disposed) return;
    this.readFailures.delete(hash);
    this.mediaVersions.set(hash, (this.mediaVersions.get(hash) || 0) + 1);
    for (const job of this.queue) if (job.asset.hash === hash) {
      job.cancelled = true;
      job.cancel?.();
    }
    this.queue = this.queue.filter(job => job.started || !job.cancelled);
    const strip = this.strips.get(hash);
    if (strip) for (const [key, v] of strip) if (v === 'pending') strip.delete(key);
    if (this.posters.get(hash)?.value === null) this.posters.delete(hash);
    const peaks = this.peakCache.get(hash);
    if (peaks && (!peaks.settled || !peaks.value?.data?.length)) this.peakCache.delete(hash);
    for (const type of ['thumb', 'poster', 'peaks']) this.emit(type, { hash });
  }

  _worker() {
    if (this.worker) return this.worker;
    const worker = this.worker = new Worker(new URL('../workers/media-worker.js', import.meta.url), { type: 'module' });
    const fail = (event) => {
      if (this.worker !== worker) return;
      event.preventDefault?.();
      worker.terminate();
      this.worker = null;
      this.workerFailures++;
      const error = Object.assign(new Error(event.message || 'Media worker failed'), { workerFailed: true });
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    };
    worker.onerror = fail;
    worker.onmessageerror = fail;
    worker.onmessage = (e) => {
      const { id, ok, result, error, partial } = e.data;
      const p = this.pending.get(id);
      if (!p) {
        partial?.bitmap?.close?.();
        return;
      }
      if (partial) {
        p.onPartial?.(partial);
        return;
      }
      this.pending.delete(id);
      this.workerFailures = 0;
      if (ok) p.resolve(result);
      else p.reject(new Error(error));
    };
    return this.worker;
  }

  _call(msg, onPartial) {
    if (this.disposed) return Promise.reject(new DOMException('Media service closed', 'AbortError'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onPartial });
      try {
        this._worker().postMessage({ ...msg, id });
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** Retry only a worker failure, with backoff; unsupported media stays cached as unavailable. */
  _retryWorkerFailure(error, retry) {
    if (this.disposed) return;
    let delay;
    if (error?.readFailed) {
      // The file could not be read (offline, a storage hiccup): tried again a few times, further
      // apart each time. A file that is not in storage at all waits to be found (forget()).
      const hash = error.readFailed;
      const tries = (this.readFailures.get(hash) || 0) + 1;
      if (this.missing.has(hash) || tries > READ_RETRIES) return;
      this.readFailures.set(hash, tries);
      delay = Math.min(60_000, 3000 * 2 ** (tries - 1));
    } else if (error?.workerFailed) delay = Math.min(60_000, 2000 * 2 ** Math.min(5, Math.max(0, this.workerFailures - 1)));
    else return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      if (!this.disposed) retry();
    }, delay);
    this.retryTimers.add(timer);
  }

  /**
   * Keep a video's thumbnails to a bounded number: scrolling a long clip at a close zoom made
   * thousands (each zoom level its own set), none let go until the editor closed. The ones
   * drawn longest ago go first; one that is needed again is made again.
   */
  _trimStrip(strip) {
    if (strip.size <= THUMBS_KEPT) return;
    for (const [key, bitmap] of strip) {
      if (strip.size <= THUMBS_KEPT) break;
      if (bitmap === 'pending') continue;
      bitmap.close?.();
      strip.delete(key);
    }
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
    if (this.disposed) return null;
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
    if (have && have !== 'pending') {
      // Used again: last in line to be let go (see _trimStrip).
      strip.delete(key);
      strip.set(key, have);
      return have;
    }
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
      job = { asset, items: [], started: false, version: this.mediaVersions.get(asset.hash) || 0 };
      this.queue.push(job);
    }
    job.items.push({ sec, key });
    clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => this._pump(), 16);
  }

  async _pump() {
    if (this.disposed || this.busy >= 2) return;
    const job = this.queue.find((j) => !j.started);
    if (!job) return;
    job.started = true;
    this.busy++;
    const current = () => !this.disposed && !job.cancelled && job.version === (this.mediaVersions.get(job.asset.hash) || 0);
    const cancelled = new Promise(resolve => { job.cancel = resolve; });
    try {
      // A replaced read may never answer. Release its slot immediately while
      // safely discarding any late decode result from the old job.
      await Promise.race([cancelled, (async () => {
        const blob = await this._pictureBlob(job.asset);
        if (!current()) return;
        const items = job.items.sort((a, b) => a.sec - b.sec);
        const strip = this.strips.get(job.asset.hash);
        await this._call({ op: 'thumbs', blob, times: items.map((i) => i.sec), height: THUMB_H }, ({ index, bitmap }) => {
          if (!current()) { bitmap?.close?.(); return; }
          strip.set(items[index].key, bitmap);
          this._trimStrip(strip);
          this.emit('thumb', { hash: job.asset.hash });
        });
      })()]);
    } catch (error) {
      if (!current()) return;
      this._retryWorkerFailure(error, () => {
        if (!current()) return;
        const strip = this.strips.get(job.asset.hash);
        for (const { key } of job.items) if (strip?.get(key) === 'pending') strip.delete(key);
        this.emit('thumb', { hash: job.asset.hash });
      });
      // Leave 'pending' markers for files that cannot be decoded.
    } finally {
      this.busy--;
      const index = this.queue.indexOf(job);
      if (index >= 0) this.queue.splice(index, 1);
      if (this.queue.some((j) => !j.started)) this._pump();
    }
  }

  /** First frame (video) or the image itself, scaled for the media library. */
  poster(asset, sync = false) {
    if (this.disposed) return sync ? null : Promise.resolve(null);
    let entry = this.posters.get(asset.hash);
    if (!entry) {
      entry = { value: null, promise: null };
      entry.promise = (async () => {
        const blob = asset.kind === 'video' ? await this._pictureBlob(asset) : await this._mediaBlob(asset);
        if (this.disposed || this.posters.get(asset.hash) !== entry) return null;
        if (asset.kind === 'image') {
          const bmp = await createImageBitmap(blob, { resizeHeight: 240, resizeQuality: 'medium' });
          return bmp;
        }
        if (asset.kind !== 'video') return null;
        let first = null;
        const t = Math.min(1, (asset.duration || 0) / 2e6);
        try {
          await this._call({ op: 'thumbs', blob, times: [t], height: 240 }, ({ bitmap }) => (first = bitmap));
        } catch (err) {
          first?.close?.();
          throw err;
        }
        return first;
      })()
        .catch((error) => {
          if (this.posters.get(asset.hash) === entry) this._retryWorkerFailure(error, () => {
            if (this.posters.get(asset.hash) !== entry) return;
            this.posters.delete(asset.hash);
            this.emit('poster', { hash: asset.hash });
            if (asset.kind === 'image') this.emit('thumb', { hash: asset.hash });
          });
          return null;
        })
        .then((v) => {
          if (this.disposed || this.posters.get(asset.hash) !== entry) {
            v?.close?.();
            return null;
          }
          entry.value = v;
          this.emit('poster', { hash: asset.hash });
          // Image thumbnails use the poster cache; timeline consumers listen
          // for thumbnail changes, including retries that need a fresh read.
          if (asset.kind === 'image') this.emit('thumb', { hash: asset.hash });
          return v;
        });
      this.posters.set(asset.hash, entry);
    }
    return sync ? entry.value : entry.promise;
  }

  /** Waveform peaks { rate, data (min,max pairs), duration } for an asset with audio. */
  peaks(asset) {
    if (this.disposed) return Promise.resolve({ rate: 100, data: new Float32Array(0), duration: 0 });
    let p = this.peakCache.get(asset.hash);
    if (!p) {
      p = this._mediaBlob(asset)
        .then((blob) => this.peakCache.get(asset.hash) === p && !this.disposed
          ? this._call({ op: 'peaks', blob, rate: 100 })
          : { rate: 100, data: new Float32Array(0), duration: 0 })
        .catch((error) => {
          if (this.peakCache.get(asset.hash) === p) this._retryWorkerFailure(error, () => {
            if (this.peakCache.get(asset.hash) !== p) return;
            this.peakCache.delete(asset.hash);
            this.emit('peaks', { hash: asset.hash });
          });
          return { rate: 100, data: new Float32Array(0), duration: 0 };
        })
        .then((r) => {
          p.settled = true;
          p.value = r;
          if (!this.disposed && this.peakCache.get(asset.hash) === p) this.emit('peaks', { hash: asset.hash });
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
    if (this.disposed) return;
    this.disposed = true;
    this._offAvailable?.();
    clearTimeout(this._flushTimer);
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    this.queue.length = 0;
    this.worker?.terminate();
    this.worker = null;
    // Termination sends no reply: explicitly settle every request waiting on the worker.
    for (const { reject } of this.pending.values()) reject(new DOMException('Media service closed', 'AbortError'));
    this.pending.clear();
    for (const strip of this.strips.values()) for (const v of strip.values()) v?.close?.();
    this.strips.clear();
    // Completed posters close now; pending requests return null after disposing their bitmap.
    for (const entry of this.posters.values()) {
      entry.value?.close?.();
      if (!entry.value) entry.promise?.then((v) => v?.close?.());
    }
    this.posters.clear();
    this.peakCache.clear();
  }
}
