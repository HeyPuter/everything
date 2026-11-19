// Video frames: decoding footage on demand and showing timeline times.
//
// Footage is decoded one frame at a time when a time needs it. WebM files
// whose codec the browser decodes with WebCodecs are read frame-accurately
// from their packets (continuing from the last decoded frame when playing
// forward); other files seek a hidden <video> element. Decoded frames become
// tile grids kept in a least-recently-used cache with a byte budget
// (Preferences → Performance), so scrubbing back reuses them and history
// states share their tiles.
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import { tileHolders } from '../../app/session';
import type { PhotoDocument } from '../../model/document';
import type { RGBA8 } from '../../imaging/types';
import { sourceMimeType } from '../../model/embedded';
import { FrameCache } from '../../model/frame-cache';
import { gridFromImage, TILE, type TileGrid } from '../../model/tiles';
import { interpretAlpha, type VideoAlpha, type VideoFootage, type VideoLayerData } from '../../model/video-layer';
import { type FrameLookup, type Placer } from '../../model/video-timeline';
import { applyTime, neededFrames, resamplePlacer, timeDocument } from '../../model/video-timeline-ops';
import { docImage } from './render';
import { demuxWebm, webCodecsCodec, webmFrameRate, type WebmFile } from '../../imaging/codecs/webm-demux';
import { mediaCleanups, timelineOf } from './video-state';

// ----- Cache -----

const cache = new FrameCache<TileGrid>(512 * 1024 * 1024);
// Cached frames keep their tiles through tile cleanup.
tileHolders.push(() => cache.values().flatMap((g) => Object.values(g.tiles)));
const frameKey = (s: DocumentSession, asset: string, alpha: VideoAlpha, frame: number) => `${s.id}:${asset}:${alpha}:${frame}`;
const gridBytes = (g: TileGrid) => Object.keys(g.tiles).length * TILE * TILE * 4;

export function setCacheLimit(mb: number) {
  cache.setLimit(Math.max(64, mb) * 1024 * 1024);
}
export const cacheStats = () => ({ frames: cache.size, bytes: cache.bytes, limit: cache.limit, decoders: decoders.size });
/** Drop every cached frame and close the decoders. */
export function purgeVideoCache() {
  cache.clear();
  placedCache.clear();
  for (const d of decoders.values()) void d.then((x) => x.close()).catch(() => {});
  decoders.clear();
}
/** Forget cached frames of one footage asset (all of them, or one frame). */
export function forgetFrames(s: DocumentSession, asset: string, frame?: number) {
  const prefix = `${s.id}:${asset}:`;
  cache.deleteWhere((k) => k.startsWith(prefix) && (frame === undefined || k.endsWith(`:${frame}`)));
}

// Closing a document drops its frames and decoders; decodes still running
// for it are not cached.
const closed = new WeakSet<DocumentSession>();
mediaCleanups.push((s) => {
  closed.add(s);
  cache.deleteWhere((k) => k.startsWith(`${s.id}:`));
  placedCache.deleteWhere((k) => k.startsWith(`${s.id}|`));
  for (const [k, d] of [...decoders])
    if (k.startsWith(`${s.id}:`)) {
      decoders.delete(k);
      void d.then((x) => x.close()).catch(() => {});
    }
});

// A cached grid is usable while its tiles are still in the session's store
// (a closed document's store is emptied).
function cached(s: DocumentSession, key: string, from = cache) {
  const g = from.get(key);
  if (!g) return undefined;
  const first = Object.values(g.tiles)[0];
  if (first && !s.assets.tiles.has(first)) {
    from.delete(key);
    return undefined;
  }
  return g;
}

// ----- Decoders -----

type Decoder = { frame(index: number): Promise<RGBA8>; close(): void };
const decoders = new Map<string, Promise<Decoder>>();
const maxDecoders = 6;

function footageBlob(s: DocumentSession, f: VideoFootage) {
  return new Blob([s.assets.blob(f.asset)], { type: f.type || 'video/webm' });
}
function decoderFor(s: DocumentSession, f: VideoFootage): Promise<Decoder> {
  const key = `${s.id}:${f.asset}`;
  let d = decoders.get(key);
  if (!d) {
    d = openDecoder(footageBlob(s, f), f);
    decoders.set(key, d);
    d.catch(() => decoders.delete(key));
    while (decoders.size > maxDecoders) {
      const [oldest, p] = decoders.entries().next().value!;
      decoders.delete(oldest);
      void p.then((x) => x.close()).catch(() => {});
    }
  } else {
    // Most recently used last.
    decoders.delete(key);
    decoders.set(key, d);
  }
  return d;
}

async function openDecoder(blob: Blob, f: VideoFootage): Promise<Decoder> {
  if (isWebm(blob, f.name) && typeof VideoDecoder !== 'undefined') {
    try {
      const file = demuxWebm(new Uint8Array(await blob.arrayBuffer()));
      const codec = webCodecsCodec(file.track.codec);
      if (codec && file.track.alphaMode !== 1 && file.frames.length && file.frames[0].key) {
        const config: VideoDecoderConfig = { codec, codedWidth: file.track.width, codedHeight: file.track.height, ...(file.track.codecPrivate ? { description: file.track.codecPrivate } : {}) };
        if ((await VideoDecoder.isConfigSupported(config)).supported) return new PacketDecoder(file, config);
      }
    } catch {
      /* Fall back to the media element. */
    }
  }
  return ElementDecoder.open(blob, f.fps);
}
const isWebm = (blob: Blob, name: string) => /webm|matroska/i.test(blob.type) || /\.(webm|mkv)$/i.test(name);

function pixelsOf(source: CanvasImageSource, width: number, height: number): RGBA8 {
  const c = new OffscreenCanvas(width, height);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(source, 0, 0, width, height);
  const img = g.getImageData(0, 0, width, height);
  return { width, height, data: img.data };
}

/** Frame-accurate decoding of WebM packets with WebCodecs. */
class PacketDecoder implements Decoder {
  private decoder?: VideoDecoder;
  // Next packet to feed, and whether the decoder needs a key frame next.
  private next = 0;
  private fresh = true;
  private fed: number[] = [];
  private wanted?: { index: number; resolve: (f: VideoFrame) => void; reject: (e: unknown) => void };
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private file: WebmFile,
    private config: VideoDecoderConfig,
  ) {}
  frame(index: number) {
    const run = this.chain.then(() => this.decode(index));
    this.chain = run.catch(() => {});
    return run;
  }
  private open() {
    this.decoder?.close();
    this.decoder = new VideoDecoder({
      output: (frame) => {
        const i = this.fed.shift();
        if (this.wanted && i === this.wanted.index) {
          const w = this.wanted;
          this.wanted = undefined;
          w.resolve(frame);
        } else frame.close();
      },
      error: (err) => {
        this.wanted?.reject(err);
        this.wanted = undefined;
        this.decoder = undefined;
      },
    });
    this.decoder.configure(this.config);
    this.fed = [];
    this.fresh = true;
  }
  private async decode(index: number): Promise<RGBA8> {
    const frames = this.file.frames;
    index = Math.max(0, Math.min(frames.length - 1, index));
    let key = index;
    while (key > 0 && !frames[key].key) key--;
    // Continue from the last decoded frame when the target lies ahead in the
    // same group of pictures; otherwise restart at its key frame.
    if (!this.decoder || this.decoder.state !== 'configured' || this.next > index || this.next < key || this.fresh) {
      if (!this.decoder || this.decoder.state !== 'configured') this.open();
      this.next = key;
      this.fresh = false;
    }
    const got = new Promise<VideoFrame>((resolve, reject) => (this.wanted = { index, resolve, reject }));
    for (let i = this.next; i <= index; i++) {
      const p = frames[i];
      this.fed.push(i);
      this.decoder!.decode(new EncodedVideoChunk({ type: p.key ? 'key' : 'delta', timestamp: Math.round(p.timestampMs * 1000), data: p.data }));
    }
    this.next = index + 1;
    // Decoders may hold the last frame back; flushing releases it (and the
    // next packet must then be a key frame).
    const timer = new Promise<'late'>((r) => setTimeout(() => r('late'), 40));
    if ((await Promise.race([got, timer])) === 'late' && this.wanted) {
      await this.decoder!.flush();
      this.fresh = true;
      // Flushing delivers every frame; one that never came was dropped.
      this.wanted?.reject(new Error('A video frame could not be decoded.'));
      this.wanted = undefined;
    }
    const frame = await got;
    try {
      return pixelsOf(frame, this.file.track.width, this.file.track.height);
    } finally {
      frame.close();
    }
  }
  close() {
    try {
      this.decoder?.close();
    } catch {
      /* Already closed. */
    }
  }
}

function mediaEvent(target: HTMLMediaElement, name: string, timeout = 15000) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('The video did not respond in time.')), timeout);
    const ok = () => done();
    const fail = () => done(new Error('This browser cannot decode this video.'));
    const done = (err?: Error) => {
      clearTimeout(timer);
      target.removeEventListener(name, ok);
      target.removeEventListener('error', fail);
      if (err) reject(err);
      else resolve();
    };
    target.addEventListener(name, ok, { once: true });
    target.addEventListener('error', fail, { once: true });
  });
}
/** Video duration in seconds; recorded WebM files often report Infinity
 * until the decoder has seen their end. */
async function mediaDuration(video: HTMLVideoElement) {
  if (Number.isFinite(video.duration)) return video.duration;
  const changed = mediaEvent(video, 'durationchange', 8000).catch(() => {});
  video.currentTime = 1e7;
  await changed;
  await mediaEvent(video, 'seeked', 8000).catch(() => {});
  return Number.isFinite(video.duration) ? video.duration : 0;
}

/** Decoding by seeking a hidden media element (formats without a demuxer here). */
class ElementDecoder implements Decoder {
  private chain: Promise<unknown> = Promise.resolve();
  private constructor(
    private video: HTMLVideoElement,
    private url: string,
    private fps: number,
    private duration: number,
  ) {}
  static async open(blob: Blob, fps: number) {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    video.src = url;
    try {
      await mediaEvent(video, 'loadeddata');
      return new ElementDecoder(video, url, fps, await mediaDuration(video));
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }
  frame(index: number) {
    const run = this.chain.then(async () => {
      const v = this.video;
      // Sample the middle of the frame, just inside the end of the file.
      const t = Math.max(0, Math.min(this.duration > 0 ? this.duration - 0.001 : Infinity, (index + 0.5) / this.fps));
      if (Math.abs(v.currentTime - t) > 1e-4) {
        const seeked = mediaEvent(v, 'seeked');
        v.currentTime = t;
        await seeked;
      }
      return pixelsOf(v, v.videoWidth, v.videoHeight);
    });
    this.chain = run.catch(() => {});
    return run;
  }
  close() {
    this.video.removeAttribute('src');
    this.video.load();
    URL.revokeObjectURL(this.url);
  }
}

// ----- Probing footage -----

const standardRates = [8, 10, 12, 12.5, 15, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120];
/** Snap a measured rate to a standard one within 1.5 %. */
export function snapFrameRate(fps: number) {
  const near = standardRates.find((r) => Math.abs(r - fps) / r < 0.015);
  return near ?? Math.round(fps * 1000) / 1000;
}

/** Size, frame count and frame rate of a video file. */
export async function probeFootage(file: Blob, name: string): Promise<Omit<VideoFootage, 'asset'>> {
  const type = file.type || (/\.webm$/i.test(name) ? 'video/webm' : /\.mp4$|\.m4v$/i.test(name) ? 'video/mp4' : /\.mov$/i.test(name) ? 'video/quicktime' : 'video/webm');
  if (isWebm(file, name)) {
    try {
      const webm = demuxWebm(new Uint8Array(await file.arrayBuffer()));
      const rate = webmFrameRate(webm);
      if (webm.frames.length && rate) return { name, type, width: webm.track.width, height: webm.track.height, frames: webm.frames.length, fps: snapFrameRate(rate) };
    } catch {
      /* Read it through the media element. */
    }
  }
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  try {
    video.src = url;
    await mediaEvent(video, 'loadeddata');
    const duration = await mediaDuration(video);
    if (!video.videoWidth || !video.videoHeight) throw new Error('The video has no picture.');
    const measured = await measureFrameRate(video);
    const fps = snapFrameRate(measured ?? 30);
    return { name, type, width: video.videoWidth, height: video.videoHeight, frames: Math.max(1, Math.round(duration * fps)), fps };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
/** Measure the frame rate by playing a few frames (where the browser reports frame times). */
async function measureFrameRate(video: HTMLVideoElement): Promise<number | undefined> {
  const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number };
  if (!v.requestVideoFrameCallback) return undefined;
  const times: number[] = [];
  video.currentTime = 0;
  await mediaEvent(video, 'seeked', 3000).catch(() => {});
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1500);
    const cb = (_now: number, meta: { mediaTime: number }) => {
      times.push(meta.mediaTime);
      if (times.length >= 10) {
        clearTimeout(timer);
        resolve();
      } else v.requestVideoFrameCallback!(cb);
    };
    v.requestVideoFrameCallback!(cb);
    video.play().catch(() => resolve());
  });
  video.pause();
  const gaps = times.slice(1).map((t, i) => t - times[i]).filter((g) => g > 1e-4).sort((a, b) => a - b);
  return gaps.length >= 3 ? 1 / gaps[gaps.length >> 1] : undefined;
}

/** Store a footage file in the session's assets. */
export async function addFootage(s: DocumentSession, file: Blob, name: string): Promise<VideoFootage> {
  const meta = await probeFootage(file, name);
  if (file.size > 512 * 1024 * 1024) throw new Error('Video files are limited to 512 MB.');
  const asset = await s.assets.add(new Blob([file], { type: sourceMimeType }));
  return { asset, ...meta };
}

// ----- Frames for times -----

/** The decoded grid of a footage frame (cached). */
const pending = new Map<string, Promise<TileGrid>>();
export async function footageGrid(s: DocumentSession, v: VideoLayerData, source: number): Promise<TileGrid> {
  const f = v.footage!;
  const key = frameKey(s, f.asset, v.alpha, source);
  const hit = cached(s, key);
  if (hit) return hit;
  let p = pending.get(key);
  if (!p) {
    p = (async () => {
      if (closed.has(s)) throw new Error('The document was closed.');
      const img = await (await decoderFor(s, f)).frame(source);
      interpretAlpha(img.data as Uint8ClampedArray, v.alpha);
      const grid = gridFromImage(s.assets.tiles, img);
      if (!closed.has(s)) cache.set(key, grid, gridBytes(grid));
      return grid;
    })();
    pending.set(key, p);
    void p.finally(() => pending.delete(key)).catch(() => {});
  }
  return p;
}
/** A lookup for the cached frames of a session; frames of transformed video
 * layers are resampled through their placement (and cached). */
export function cacheLookup(s: DocumentSession): FrameLookup {
  const lookup: FrameLookup = (l, _k, source) => (l.video?.footage ? cached(s, frameKey(s, l.video.footage.asset, l.video.alpha, source)) : undefined);
  lookup.place = placer(s);
  return lookup;
}

// Resampled placements of frames, by source tiles and matrix.
const placedCache = new FrameCache<TileGrid>(256 * 1024 * 1024);
tileHolders.push(() => placedCache.values().flatMap((g) => Object.values(g.tiles)));
export function placer(s: DocumentSession): Placer {
  const resample = resamplePlacer(s.assets.tiles, 'bicubic');
  return (grid, m) => {
    const key = `${s.id}|${grid.x},${grid.y}|${Object.entries(grid.tiles).join(';')}|${m.join(',')}`;
    const hit = cached(s, key, placedCache);
    if (hit) return hit;
    const out = resample(grid, m);
    if (out && !closed.has(s)) placedCache.set(key, out, gridBytes(out));
    return out;
  };
}
/** Decode the frames a document needs at time `t`; returns a lookup for them. */
export async function ensureFrames(s: DocumentSession, doc: PhotoDocument, t: number): Promise<FrameLookup> {
  const need = neededFrames(doc, t);
  const failures: unknown[] = [];
  await Promise.all(need.map((n) => footageGrid(s, n.layer.video, n.source).catch((err) => failures.push(err))));
  if (failures.length && failures.length === need.length) throw failures[0] instanceof Error ? failures[0] : new Error('The video could not be decoded.');
  return cacheLookup(s);
}
/** Decode ahead of playback without waiting. */
export function prefetchFrames(s: DocumentSession, doc: PhotoDocument, t: number) {
  for (const n of neededFrames(doc, t)) void footageGrid(s, n.layer.video, n.source).catch(() => {});
}

// ----- Showing a time -----

let request = 0;
/** Show timeline frame `t` (one coalesced history step), once its video
 * frames are decoded. Later requests win over earlier ones. */
export async function setTime(e: Editor, t: number) {
  const tl = timelineOf(e);
  // Recorded actions pass the frame; a missing one moves nothing.
  if (!tl || !Number.isFinite(t)) return;
  const my = ++request;
  const s = e.session;
  t = Math.max(0, Math.min(tl.duration - 1, Math.round(t)));
  let doc = e.doc;
  let lookup = await ensureFrames(s, doc, t);
  // Another edit while decoding: decode for the latest state.
  while (e.session === s && e.doc !== doc) {
    doc = e.doc;
    if (!doc.timeline) return;
    lookup = await ensureFrames(s, doc, t);
  }
  if (my !== request || e.session !== s || !e.doc.timeline) return;
  // Showing the time already shown changes nothing and adds no step.
  e.command('Set Current Time', (d) => applyTime(d, t, lookup), { coalesce: true });
}

/** Edit the timeline as one undo step and show the current time in the
 * result: frames the edited document needs are decoded first. */
export async function editTimeline(e: Editor, label: string, edit: (d: PhotoDocument) => void | false, at?: number) {
  if (!timelineOf(e)) return;
  const draft = structuredClone(e.doc);
  if (edit(draft) === false) return;
  const t = at ?? draft.timeline?.current ?? 0;
  const lookup = draft.timeline ? await ensureFrames(e.session, draft, t) : undefined;
  e.command(label, (d) => {
    if (edit(d) === false) return;
    if (d.timeline) applyTime(d, at ?? d.timeline.current, lookup);
  });
}

// ----- Rendered times (onion skins) -----

const stamps = new WeakMap<PhotoDocument, number>();
let stamp = 0;
/** The cached render of a document at timeline frame `t`, queued when missing. */
export function timeImage(e: Editor, doc: PhotoDocument, t: number) {
  let id = stamps.get(doc);
  if (id === undefined) stamps.set(doc, (id = ++stamp));
  const s = e.session;
  return docImage(e, `${s.id}:time:${id}:${t}`, async () => timeDocument(doc, t, await ensureFrames(s, doc, t)));
}
