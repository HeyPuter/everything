// Media decoding and caches, keyed by the (shared, immutable) media byte arrays so they survive
// undo snapshots: images → ImageBitmap, movies → <video> seeking with a frame cache (or live
// playback while the timeline plays), sounds → AudioBuffer + waveform peaks, movie thumbnails.
import { mixPeaks } from './wav';

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ogv: 'video/ogg',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/ogg',
};

export function mimeFor(name: string, given = '') {
  if (given) return given;
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export function mediaKind(name: string, mime = ''): 'image' | 'movie' | 'sound' | null {
  const m = mimeFor(name, mime);
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'movie';
  if (m.startsWith('audio/')) return 'sound';
  return null;
}

const blobOf = (bytes: Uint8Array, mime: string) => new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime });

// ---------------------------------------------------------------------------
// images

const images = new WeakMap<Uint8Array, Promise<ImageBitmap>>();
const imagesReady = new WeakMap<Uint8Array, ImageBitmap>();

export function loadImage(bytes: Uint8Array, mime: string): Promise<ImageBitmap> {
  let p = images.get(bytes);
  if (!p) {
    p = createImageBitmap(blobOf(bytes, mime), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }).then((b) => {
      imagesReady.set(bytes, b);
      return b;
    });
    images.set(bytes, p);
  }
  return p;
}

/** Already decoded image (for synchronous drawing), triggering the decode otherwise. */
export function imageNow(bytes: Uint8Array, mime: string, onReady?: () => void): ImageBitmap | null {
  const b = imagesReady.get(bytes);
  if (b) return b;
  // an image that cannot be decoded just has no thumbnail (no unhandled rejection per redraw)
  loadImage(bytes, mime).then(
    () => onReady?.(),
    () => {},
  );
  return null;
}

// ---------------------------------------------------------------------------
// movies

export interface MovieInfo {
  width: number;
  height: number;
  duration: number;
  /** estimated native frame rate (0 if unknown) */
  fps: number;
  hasAudio: boolean;
}

const FRAME_BUDGET = 1920 * 1080 * 48; // pixels kept in the frame cache per movie

export class Movie {
  readonly url: string;
  readonly video: HTMLVideoElement;
  info: Promise<MovieInfo>;
  private cache = new Map<string, { bmp: ImageBitmap; px: number }>();
  private cachePx = 0;
  private queue: Promise<unknown> = Promise.resolve();
  lastLive = 0;
  /** last time a caller asked for this movie (getMovie) */
  lastUsed = performance.now();
  error: string | null = null;
  private disposed = false;

  constructor(bytes: Uint8Array, mime: string) {
    this.url = URL.createObjectURL(blobOf(bytes, mime));
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    v.src = this.url;
    this.video = v;
    this.info = new Promise<MovieInfo>((resolve, reject) => {
      v.addEventListener(
        'loadeddata',
        () => {
          const anyV = v as HTMLVideoElement & { mozHasAudio?: boolean; webkitAudioDecodedByteCount?: number; audioTracks?: { length: number } };
          void estimateFps(v).then((fps) =>
            resolve({ width: v.videoWidth, height: v.videoHeight, duration: isFinite(v.duration) ? v.duration : 0, fps, hasAudio: !!(anyV.mozHasAudio || (anyV.audioTracks?.length ?? 0) > 0 || anyV.webkitAudioDecodedByteCount) }),
          );
        },
        { once: true },
      );
      v.addEventListener(
        'error',
        () => {
          this.error = v.error?.message || 'cannot decode movie';
          reject(new Error(this.error));
        },
        { once: true },
      );
    });
    this.info.catch(() => {});
  }

  /**
   * Exact frame at `time` seconds (serialised seeks, cached as bitmaps of the given width). With
   * `keep` false a decoded frame is not cached (the caller closes it unless `isCached` says so).
   */
  frame(time: number, width = 0, keep = true): Promise<ImageBitmap | null> {
    const key = `${time.toFixed(4)}@${width}`;
    const hit = this.cache.get(key);
    if (hit) {
      // refresh LRU order
      this.cache.delete(key);
      this.cache.set(key, hit);
      return Promise.resolve(hit.bmp);
    }
    const job = this.queue.then(async () => {
      const again = this.cache.get(key);
      if (again) return again.bmp;
      const info = await this.info;
      // released (its strip was deleted): no element to seek any more
      if (this.disposed) return null;
      const v = this.video;
      if (!v.paused) v.pause();
      const t = Math.max(0, Math.min(time, Math.max(0, info.duration - 1e-3)));
      if (Math.abs(v.currentTime - t) > 1e-4 || v.readyState < 2) {
        await new Promise<void>((res) => {
          const done = () => {
            clearTimeout(timer);
            v.removeEventListener('seeked', done);
            res();
          };
          const timer = setTimeout(done, 4000);
          v.addEventListener('seeked', done);
          v.currentTime = t;
        });
      }
      if (v.readyState < 2) return null;
      const w = width > 0 ? Math.min(width, v.videoWidth) : v.videoWidth;
      const h = Math.max(1, Math.round((w * v.videoHeight) / Math.max(1, v.videoWidth)));
      const bmp = await createImageBitmap(v, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      if (keep) this.store(key, bmp, w * h);
      return bmp;
    });
    this.queue = job.catch(() => null);
    return job;
  }

  private store(key: string, bmp: ImageBitmap, px: number) {
    this.cache.set(key, { bmp, px });
    this.cachePx += px;
    for (const [k, v] of this.cache) {
      if (this.cachePx <= FRAME_BUDGET) break;
      if (k === key) continue;
      v.bmp.close();
      this.cachePx -= v.px;
      this.cache.delete(k);
    }
  }

  get cachedFrames() {
    return this.cache.size;
  }

  /** Whether a bitmap returned by `frame` belongs to the cache (and must not be closed). */
  isCached(bmp: ImageBitmap) {
    for (const v of this.cache.values()) if (v.bmp === bmp) return true;
    return false;
  }

  clearCache() {
    for (const v of this.cache.values()) v.bmp.close();
    this.cache.clear();
    this.cachePx = 0;
  }

  /**
   * Live playback: keep the element playing near `time` and return it as the frame source
   * (re-seeks when drifting more than a few frames).
   */
  live(time: number, rate = 1): HTMLVideoElement | null {
    const v = this.video;
    this.lastLive = performance.now();
    if (v.readyState < 2) {
      if (Math.abs(v.currentTime - time) > 0.3) v.currentTime = time;
      return null;
    }
    if (Math.abs(v.currentTime - time) > 0.2) v.currentTime = time;
    v.playbackRate = rate;
    if (v.paused) void v.play().catch(() => {});
    return v;
  }

  pauseIfIdle() {
    if (!this.video.paused && performance.now() - this.lastLive > 250) this.video.pause();
  }

  /** Free the frame cache, the element's decoder and the object URL (the movie is unusable after). */
  dispose() {
    this.disposed = true;
    this.clearCache();
    const v = this.video;
    v.pause();
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(this.url);
  }
}

async function estimateFps(v: HTMLVideoElement): Promise<number> {
  const rv = v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number; presentedFrames: number }) => void) => number };
  if (!rv.requestVideoFrameCallback) return 0;
  const times: number[] = [];
  const start = v.currentTime;
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1200);
      const cb = (_now: number, meta: { mediaTime: number }) => {
        times.push(meta.mediaTime);
        if (times.length >= 8) {
          clearTimeout(timer);
          resolve();
        } else rv.requestVideoFrameCallback!(cb);
      };
      rv.requestVideoFrameCallback!(cb);
      void v.play().catch(() => resolve());
    });
  } finally {
    v.pause();
    v.currentTime = start;
  }
  const d: number[] = [];
  for (let i = 1; i < times.length; i++) if (times[i] > times[i - 1]) d.push(times[i] - times[i - 1]);
  if (!d.length) return 0;
  d.sort((a, b) => a - b);
  const fps = 1 / d[Math.floor(d.length / 2)];
  // snap to common rates
  for (const r of [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120]) if (Math.abs(fps - r) / r < 0.03) return r;
  return Math.round(fps * 100) / 100;
}

const movies = new Map<Uint8Array, Movie>();

export function getMovie(bytes: Uint8Array, mime: string): Movie {
  let m = movies.get(bytes);
  if (!m) {
    m = new Movie(bytes, mime);
    movies.set(bytes, m);
  }
  m.lastUsed = performance.now();
  return m;
}

/**
 * Release the movies and thumbnail sources of media no strip uses any more (deleted strips, failed
 * loads, other documents): their decoders, frame caches and object URLs. Media asked for within the
 * last `graceMs` stay (a movie being added is not in the document yet). Returns whether unused media
 * are still waiting for the grace period to end.
 */
export function releaseUnusedMedia(used: Set<Uint8Array>, graceMs = 5000): boolean {
  const now = performance.now();
  let waiting = false;
  for (const [bytes, m] of movies) {
    if (used.has(bytes)) continue;
    if (now - m.lastUsed < graceMs) waiting = true;
    else {
      m.dispose();
      movies.delete(bytes);
    }
  }
  for (const [bytes, t] of thumbs) {
    if (used.has(bytes)) continue;
    if (now - t.lastUsed < graceMs) waiting = true;
    else {
      for (const b of t.cache.values()) b.close();
      t.cache.clear();
      t.video.removeAttribute('src');
      t.video.load();
      URL.revokeObjectURL(t.url);
      thumbs.delete(bytes);
    }
  }
  return waiting;
}

/** Pause movies that are no longer being played back live. */
export function pauseIdleMovies() {
  for (const m of movies.values()) m.pauseIfIdle();
}

export function clearMovieCaches() {
  for (const m of movies.values()) m.clearCache();
}

export function movieCacheStats() {
  let frames = 0;
  for (const m of movies.values()) frames += m.cachedFrames;
  return { movies: movies.size, frames };
}

// ---------------------------------------------------------------------------
// sound

let decodeCtx: OfflineAudioContext | null = null;
export const MIX_RATE = 48000;

/** Playback device settings (Preferences ▸ System ▸ Sound); applied when playback (re)starts. */
export const audioSettings = { sampleRate: 0, latency: 'interactive' as AudioContextLatencyCategory, channels: 2 };

/** A live audio context matching the settings; `prev` is reused when it still matches, else closed. */
export function playbackContext(prev: AudioContext | null): AudioContext {
  const key = `${audioSettings.sampleRate}|${audioSettings.latency}`;
  const tagged = prev as (AudioContext & { __key?: string }) | null;
  if (tagged && tagged.__key === key && tagged.state !== 'closed') {
    applyChannels(tagged);
    return tagged;
  }
  if (tagged && tagged.state !== 'closed') void tagged.close().catch(() => {});
  let c: AudioContext & { __key?: string };
  try {
    c = new AudioContext(audioSettings.sampleRate > 0 ? { latencyHint: audioSettings.latency, sampleRate: audioSettings.sampleRate } : { latencyHint: audioSettings.latency });
  } catch {
    // the device may not support the rate: fall back to its own
    c = new AudioContext({ latencyHint: audioSettings.latency });
  }
  c.__key = key;
  applyChannels(c);
  return c;
}

function applyChannels(c: AudioContext) {
  try {
    const n = Math.max(1, Math.min(c.destination.maxChannelCount || 2, audioSettings.channels));
    if (c.destination.channelCount !== n) c.destination.channelCount = n;
  } catch {
    // some outputs have a fixed layout
  }
}
const sounds = new WeakMap<Uint8Array, Promise<AudioBuffer | null>>();
const soundsReady = new WeakMap<Uint8Array, AudioBuffer | null>();

export function loadSound(bytes: Uint8Array): Promise<AudioBuffer | null> {
  let p = sounds.get(bytes);
  if (!p) {
    decodeCtx ??= new OfflineAudioContext(2, 1, MIX_RATE);
    const copy = bytes.slice().buffer;
    p = decodeCtx
      .decodeAudioData(copy)
      .then((b) => b)
      .catch(() => null)
      .then((b) => {
        soundsReady.set(bytes, b);
        return b;
      });
    sounds.set(bytes, p);
  }
  return p;
}

export function soundNow(bytes: Uint8Array, onReady?: () => void): AudioBuffer | null | undefined {
  if (soundsReady.has(bytes)) return soundsReady.get(bytes);
  void loadSound(bytes).then(() => onReady?.());
  return undefined;
}

const PEAKS_PER_SECOND = 200;
const peakCache = new WeakMap<AudioBuffer, Float32Array>();

/** Min/max peaks (mono mix) at 200 buckets per second. */
export function soundPeaks(buf: AudioBuffer): Float32Array {
  let p = peakCache.get(buf);
  if (!p) {
    const chans: Float32Array[] = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    p = mixPeaks(chans, Math.max(1, Math.ceil(buf.duration * PEAKS_PER_SECOND)));
    peakCache.set(buf, p);
  }
  return p;
}
export { PEAKS_PER_SECOND };

// ---------------------------------------------------------------------------
// thumbnails (separate video element so they never disturb preview seeks)

const THUMB_H = 48;
interface ThumbSource {
  url: string;
  lastUsed: number;
  video: HTMLVideoElement;
  ready: Promise<boolean>;
  cache: Map<number, ImageBitmap>;
  pending: Set<number>;
  queue: Promise<unknown>;
}
const thumbs = new Map<Uint8Array, ThumbSource>();

/** Thumbnail at `time` (rounded to 0.1 s); `onReady` is called when a missing one is decoded. */
export function movieThumb(bytes: Uint8Array, mime: string, time: number, onReady: () => void): ImageBitmap | null {
  let t = thumbs.get(bytes);
  if (!t) {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    const url = URL.createObjectURL(blobOf(bytes, mime));
    v.src = url;
    const ready = new Promise<boolean>((res) => {
      v.addEventListener('loadeddata', () => res(true), { once: true });
      v.addEventListener('error', () => res(false), { once: true });
    });
    t = { url, lastUsed: 0, video: v, ready, cache: new Map(), pending: new Set(), queue: Promise.resolve() };
    thumbs.set(bytes, t);
  }
  t.lastUsed = performance.now();
  const key = Math.round(time * 10);
  const hit = t.cache.get(key);
  if (hit) return hit;
  if (t.pending.has(key) || t.pending.size > 24) return null;
  t.pending.add(key);
  const src = t;
  src.queue = src.queue.then(async () => {
    try {
      if (!(await src.ready)) return;
      const v = src.video;
      const target = Math.min(key / 10, Math.max(0, (isFinite(v.duration) ? v.duration : 0) - 1e-3));
      await new Promise<void>((res) => {
        const done = () => {
          clearTimeout(timer);
          v.removeEventListener('seeked', done);
          res();
        };
        const timer = setTimeout(done, 3000);
        v.addEventListener('seeked', done);
        v.currentTime = target;
      });
      if (v.readyState >= 2 && v.videoHeight) {
        const h = THUMB_H;
        const w = Math.max(1, Math.round((h * v.videoWidth) / v.videoHeight));
        src.cache.set(key, await createImageBitmap(v, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' }));
        if (src.cache.size > 400) {
          const first = src.cache.keys().next().value!;
          src.cache.get(first)?.close();
          src.cache.delete(first);
        }
        onReady();
      }
    } finally {
      src.pending.delete(key);
    }
  });
  return null;
}
