// Footage decoding and the frame cache.
// - Movie files: demuxed (MP4/WebM) and decoded frame-accurately with WebCodecs; when the
//   container/codec is not supported the clip falls back to seeking an HTMLVideoElement.
// - Image sequences: each image decoded with createImageBitmap.
// Decoded frames (ImageBitmap) and grayscale versions for the tracker live in one LRU cache with
// a memory limit shared by all clips.
import { demux, presentationOrder, type VideoTrackInfo } from './demux';
import type { MovieClipData } from './types';

// ---------------------------------------------------------------------------
// cache

export const cacheSettings = {
  /** memory limit of the clip frame cache in megabytes */
  limitMB: 1024,
};

interface CacheEntry {
  bmp?: ImageBitmap;
  gray?: Uint8Array;
  bytes: number;
}

class FrameCache {
  private map = new Map<string, CacheEntry>();
  used = 0;
  get(key: string): CacheEntry | undefined {
    const e = this.map.get(key);
    if (e) {
      this.map.delete(key);
      this.map.set(key, e);
    }
    return e;
  }
  has(key: string) {
    return this.map.has(key);
  }
  put(key: string, e: CacheEntry) {
    const old = this.map.get(key);
    if (old) this.drop(key, old);
    this.map.set(key, e);
    this.used += e.bytes;
    const limit = Math.max(16, cacheSettings.limitMB) * 1024 * 1024;
    for (const [k, v] of this.map) {
      if (this.used <= limit || this.map.size <= 2) break;
      if (k === key) continue;
      this.drop(k, v);
    }
  }
  private drop(k: string, v: CacheEntry) {
    this.map.delete(k);
    this.used -= v.bytes;
    v.bmp?.close();
  }
  clear(prefix: string) {
    for (const [k, v] of [...this.map]) if (k.startsWith(prefix)) this.drop(k, v);
  }
  /** cached frame indices for a source prefix (for the timeline cache line) */
  indices(prefix: string): number[] {
    const out: number[] = [];
    for (const k of this.map.keys()) if (k.startsWith(prefix) && !k.includes(':g')) out.push(Number(k.slice(prefix.length)));
    return out;
  }
}

export const frameCache = new FrameCache();

// ---------------------------------------------------------------------------
// sources

export interface Gray {
  w: number;
  h: number;
  data: Uint8Array;
}

export interface ChannelMask {
  r: boolean;
  g: boolean;
  b: boolean;
}

let sourceCounter = 0;

export abstract class FrameSource {
  readonly key = `s${++sourceCounter}:`;
  width = 0;
  height = 0;
  frameCount = 0;
  fps = 24;
  kind: 'webcodecs' | 'video' | 'images' = 'images';
  error: string | null = null;
  private inflight = new Map<number, Promise<ImageBitmap | null>>();
  private queue: Promise<unknown> = Promise.resolve();

  /** cached frame (no decoding) */
  peek(index: number): ImageBitmap | null {
    return frameCache.get(this.key + index)?.bmp ?? null;
  }

  cached(): number[] {
    return frameCache.indices(this.key);
  }

  get(index: number): Promise<ImageBitmap | null> {
    if (index < 0 || index >= this.frameCount) return Promise.resolve(null);
    const c = this.peek(index);
    if (c) return Promise.resolve(c);
    let p = this.inflight.get(index);
    if (p) return p;
    // decoding is serialized per source (decoders and video elements are stateful)
    p = (this.queue = this.queue.then(
      () => this.peek(index) ?? this.decode(index).catch((e) => ((this.error = e instanceof Error ? e.message : String(e)), null)),
      () => null,
    )) as Promise<ImageBitmap | null>;
    this.inflight.set(index, p);
    void p.finally(() => this.inflight.delete(index));
    return p;
  }

  protected store(index: number, bmp: ImageBitmap) {
    frameCache.put(this.key + index, { bmp, bytes: bmp.width * bmp.height * 4 });
  }

  protected abstract decode(index: number): Promise<ImageBitmap | null>;

  private canvas: OffscreenCanvas | HTMLCanvasElement | null = null;

  /** Grayscale (luma of the enabled channels) of a frame, cached. */
  async gray(index: number, ch: ChannelMask = { r: true, g: true, b: true }): Promise<Gray | null> {
    const hit = this.graySync(index, ch);
    if (hit) return hit;
    if (!(await this.get(index))) return null;
    return this.graySync(index, ch);
  }

  /** Grayscale of a frame when its pixels are already decoded (no waiting), else null. */
  graySync(index: number, ch: ChannelMask = { r: true, g: true, b: true }): Gray | null {
    const mask = (ch.r ? 1 : 0) | (ch.g ? 2 : 0) | (ch.b ? 4 : 0) || 7;
    const gk = `${this.key}g${mask}:${index}`;
    const hit = frameCache.get(gk)?.gray;
    if (hit) return { w: this.width, h: this.height, data: hit };
    const bmp = this.peek(index);
    if (!bmp) return null;
    const px = this.pixels(bmp);
    if (!px) return null;
    const wr = mask & 1 ? 0.2126 : 0,
      wg = mask & 2 ? 0.7152 : 0,
      wb = mask & 4 ? 0.0722 : 0;
    const s = wr + wg + wb;
    const out = new Uint8Array(bmp.width * bmp.height);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (px[j] * wr + px[j + 1] * wg + px[j + 2] * wb) / s;
    frameCache.put(gk, { gray: out, bytes: out.length });
    return { w: bmp.width, h: bmp.height, data: out };
  }

  /** RGBA pixels of a decoded frame. */
  pixels(bmp: ImageBitmap): Uint8ClampedArray | null {
    const w = bmp.width,
      h = bmp.height;
    if (!this.canvas || this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    }
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0);
    return ctx.getImageData(0, 0, w, h).data;
  }

  dispose() {
    frameCache.clear(this.key);
  }
}

class ImageSequenceSource extends FrameSource {
  constructor(private frames: { mime: string; bytes: Uint8Array }[]) {
    super();
    this.kind = 'images';
    this.frameCount = frames.length;
  }
  async init() {
    const first = await this.decode(0);
    if (first) {
      this.width = first.width;
      this.height = first.height;
    }
    return this;
  }
  protected async decode(index: number) {
    const f = this.frames[index];
    if (!f) return null;
    const bmp = await createImageBitmap(new Blob([f.bytes as Uint8Array<ArrayBuffer>], { type: f.mime }));
    this.store(index, bmp);
    return bmp;
  }
}

/** Fallback: seek an HTMLVideoElement (frame accuracy depends on the browser). */
class VideoElementSource extends FrameSource {
  private video: HTMLVideoElement;
  private url: string;
  constructor(
    bytes: Uint8Array,
    mime: string,
    private hintFps: number,
  ) {
    super();
    this.kind = 'video';
    this.url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime || 'video/mp4' }));
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.preload = 'auto';
    this.video.playsInline = true;
    this.video.src = this.url;
  }
  async init() {
    const v = this.video;
    if (v.readyState < 1)
      await new Promise<void>((res, rej) => {
        v.addEventListener('loadedmetadata', () => res(), { once: true });
        v.addEventListener('error', () => rej(new Error('The browser cannot decode this video')), { once: true });
      });
    this.width = v.videoWidth;
    this.height = v.videoHeight;
    this.fps = this.hintFps || 24;
    this.frameCount = Math.max(1, Math.round((Number.isFinite(v.duration) ? v.duration : 0) * this.fps));
    return this;
  }
  protected async decode(index: number) {
    const v = this.video;
    const t = (index + 0.5) / this.fps;
    if (Math.abs(v.currentTime - t) > 1e-4 || v.readyState < 2) {
      await new Promise<void>((res) => {
        const done = () => res();
        v.addEventListener('seeked', done, { once: true });
        v.currentTime = t;
        setTimeout(done, 3000);
      });
    }
    // wait for the frame to be presented when supported
    const rvfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => void }).requestVideoFrameCallback;
    if (rvfc && v.readyState < 2) await new Promise<void>((res) => (rvfc.call(v, () => res()), setTimeout(res, 200)));
    const bmp = await createImageBitmap(v);
    this.store(index, bmp);
    return bmp;
  }
  dispose() {
    super.dispose();
    URL.revokeObjectURL(this.url);
    this.video.removeAttribute('src');
  }
}

/** A video element source, released again when the browser cannot open the footage. */
async function openVideoElement(bytes: Uint8Array, mime: string, fps: number): Promise<VideoElementSource> {
  const v = new VideoElementSource(bytes, mime, fps);
  try {
    return await v.init();
  } catch (e) {
    v.dispose();
    throw e;
  }
}

/** Frame-accurate WebCodecs decoding of demuxed samples. */
class WebCodecsSource extends FrameSource {
  private order: number[];
  private decodeToPres: number[];
  private ptsToPres = new Map<number, number>();
  private decoder: VideoDecoder | null = null;
  private nextFeed = 0;
  private continuous = false;
  private keep: [number, number] = [0, 0];
  private waiters = new Map<number, (b: ImageBitmap | null) => void>();
  private pendingBitmaps = 0;
  private failed: unknown = null;
  constructor(
    private bytes: Uint8Array,
    private info: VideoTrackInfo,
  ) {
    super();
    this.kind = 'webcodecs';
    this.order = presentationOrder(info);
    this.decodeToPres = new Array(this.order.length);
    this.order.forEach((d, p) => {
      this.decodeToPres[d] = p;
      this.ptsToPres.set(info.samples[d].pts, p);
    });
    this.width = info.width;
    this.height = info.height;
    this.frameCount = info.samples.length;
    this.fps = info.fps;
  }

  private config(): VideoDecoderConfig {
    return { codec: this.info.codec, description: this.info.description, codedWidth: this.info.width, codedHeight: this.info.height, optimizeForLatency: true } as VideoDecoderConfig;
  }

  static async supported(info: VideoTrackInfo) {
    const VD = (globalThis as { VideoDecoder?: typeof VideoDecoder }).VideoDecoder;
    if (!VD) return false;
    try {
      const r = await VD.isConfigSupported({ codec: info.codec, description: info.description, codedWidth: info.width, codedHeight: info.height } as VideoDecoderConfig);
      return !!r.supported;
    } catch {
      return false;
    }
  }

  private reset() {
    if (!this.decoder || this.decoder.state === 'closed') {
      this.decoder = new VideoDecoder({
        output: (frame) => this.onFrame(frame),
        error: (e) => {
          this.failed = e;
          for (const w of this.waiters.values()) w(null);
          this.waiters.clear();
        },
      });
    } else this.decoder.reset();
    this.decoder.configure(this.config());
    this.continuous = true;
  }

  private onFrame(frame: VideoFrame) {
    const pres = this.ptsToPres.get(frame.timestamp);
    if (pres === undefined || pres < this.keep[0] || pres > this.keep[1] || this.peek(pres)) {
      frame.close();
      return;
    }
    this.pendingBitmaps++;
    createImageBitmap(frame)
      .then((bmp) => {
        this.store(pres, bmp);
        const w = this.waiters.get(pres);
        if (w) {
          this.waiters.delete(pres);
          w(bmp);
        }
      })
      .catch(() => {})
      .finally(() => {
        frame.close();
        this.pendingBitmaps--;
      });
  }

  private feed(d: number) {
    const s = this.info.samples[d];
    this.decoder!.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: s.pts, data: this.bytes.subarray(s.offset, s.offset + s.size) }));
    this.nextFeed = d + 1;
  }

  protected async decode(index: number): Promise<ImageBitmap | null> {
    if (this.failed) throw this.failed instanceof Error ? this.failed : new Error(String(this.failed));
    const d = this.order[index];
    let k = d;
    while (k > 0 && !this.info.samples[k].key) k--;
    // keep frames around the target (prefetch-friendly), bounded by the cache budget
    const frameBytes = this.width * this.height * 4;
    const ahead = Math.max(1, Math.min(48, Math.floor((cacheSettings.limitMB * 1024 * 1024) / Math.max(1, frameBytes) / 4)));
    this.keep = [index, index + ahead];
    const canContinue = this.decoder && this.continuous && this.decoder.state === 'configured' && this.nextFeed > k && this.nextFeed <= d + 1;
    if (!canContinue) {
      this.reset();
      this.nextFeed = k;
    }
    const got = new Promise<ImageBitmap | null>((res) => this.waiters.set(index, res));
    while (this.nextFeed <= d) this.feed(this.nextFeed);
    // reordering codecs may need a few more samples before the target is output
    const deadline = performance.now() + 4000;
    let extra = 0;
    while (!this.peek(index) && !this.failed) {
      const r = await Promise.race([got, new Promise<null>((res) => setTimeout(() => res(null), 4))]);
      if (r) return r;
      if (this.peek(index)) break;
      if (this.decoder!.decodeQueueSize === 0 && this.pendingBitmaps === 0) {
        if (extra < 16 && this.nextFeed < this.info.samples.length) {
          this.feed(this.nextFeed);
          extra++;
        } else {
          await this.decoder!.flush();
          this.continuous = false; // a flush requires the next chunk to be a key frame
          await new Promise((res) => setTimeout(res, 0));
          while (this.pendingBitmaps > 0) await new Promise((res) => setTimeout(res, 1));
          break;
        }
      }
      if (performance.now() > deadline) break;
    }
    this.waiters.delete(index);
    if (this.failed) throw this.failed instanceof Error ? this.failed : new Error(String(this.failed));
    return this.peek(index);
  }

  dispose() {
    super.dispose();
    try {
      this.decoder?.close();
    } catch {
      // already closed
    }
  }
}

/** Movie source that switches to the video element fallback when WebCodecs decoding fails. */
class MovieSource extends FrameSource {
  impl!: FrameSource;
  info: VideoTrackInfo | null = null;
  constructor(
    private bytes: Uint8Array,
    private mime: string,
  ) {
    super();
  }
  async init() {
    this.info = demux(this.bytes);
    if (this.info && (await WebCodecsSource.supported(this.info))) this.impl = new WebCodecsSource(this.bytes, this.info);
    else this.impl = await openVideoElement(this.bytes, this.mime, this.info?.fps ?? 0);
    this.sync();
    return this;
  }
  private sync() {
    this.width = this.impl.width;
    this.height = this.impl.height;
    this.frameCount = this.impl.frameCount;
    this.fps = this.impl.fps;
    this.kind = this.impl.kind;
  }
  peek(index: number) {
    return this.impl?.peek(index) ?? null;
  }
  cached() {
    return this.impl?.cached() ?? [];
  }
  get(index: number): Promise<ImageBitmap | null> {
    return this.impl.get(index).then(async (b) => {
      if (b || this.impl.kind !== 'webcodecs' || !this.impl.error) return b;
      // WebCodecs failed on this stream: fall back to seeking a video element
      this.impl.dispose();
      this.impl = await openVideoElement(this.bytes, this.mime, this.info?.fps ?? 0);
      const n = this.frameCount;
      this.sync();
      this.frameCount = n || this.impl.frameCount;
      return this.impl.get(index);
    });
  }
  protected decode(): Promise<ImageBitmap | null> {
    return Promise.resolve(null);
  }
  dispose() {
    this.impl?.dispose();
  }
}

// ---------------------------------------------------------------------------
// per-clip runtime (keyed by the immutable footage bytes so undo snapshots share decoders)

const sources = new WeakMap<Uint8Array, Promise<FrameSource>>();
const ready = new WeakMap<Uint8Array, FrameSource>();
/** footage that could not be opened (not retried on every redraw; Reload tries again) */
const failures = new WeakMap<Uint8Array, string>();

function footageKey(clip: MovieClipData): Uint8Array | null {
  if (clip.source === 'MOVIE') return clip.movie?.bytes ?? null;
  return clip.sequence?.[0]?.bytes ?? null;
}

/** Frame source of a clip (created on first use). */
export function clipSource(clip: MovieClipData): Promise<FrameSource> | null {
  const key = footageKey(clip);
  if (!key) return null;
  let p = sources.get(key);
  if (!p) {
    p = clip.source === 'MOVIE' ? new MovieSource(key, clip.movie!.mime).init() : new ImageSequenceSource(clip.sequence!).init();
    p.then((s) => ready.set(key, s)).catch((e) => failures.set(key, e instanceof Error ? e.message : String(e)));
    sources.set(key, p);
  }
  return p;
}

/** Ready frame source of a clip, or null while it is still being opened. */
export function readySource(clip: MovieClipData): FrameSource | null {
  const key = footageKey(clip);
  if (!key) return null;
  const s = ready.get(key);
  if (!s) void clipSource(clip);
  return s ?? null;
}

/** Why the clip's footage could not be opened (null when it opened or is still opening). */
export function sourceError(clip: MovieClipData): string | null {
  const key = footageKey(clip);
  return key ? (failures.get(key) ?? null) : null;
}

/** Probe footage to fill a new clip's size/length/fps. */
export async function probeFootage(clip: MovieClipData): Promise<FrameSource> {
  const p = clipSource(clip);
  if (!p) throw new Error('The clip has no footage');
  const s = await p;
  clip.size = [s.width, s.height];
  clip.frame_duration = s.frameCount;
  clip.fps = s.fps;
  return s;
}

/** Drop decoded frames of a clip (Reload). */
export function reloadSource(clip: MovieClipData) {
  const key = footageKey(clip);
  if (!key) return;
  ready.get(key)?.dispose();
  ready.delete(key);
  sources.delete(key);
  failures.delete(key);
}
