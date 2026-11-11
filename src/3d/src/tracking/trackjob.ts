// Tracking jobs on the main thread: gathers the frames and image regions the tracker needs,
// runs the tracker/detector in a small Web Worker pool and writes the resulting markers.
import { cropRegion, pyramidLevels, regionRect, type P2, type TrackParams, type TrackResult } from './tracker';
import { handle, type TrackItem, type WorkerRequest, type WorkerResponse } from './worker';
import type { DetectOptions, Feature } from './detect';
import { clipSource, type ChannelMask, type FrameSource, type Gray } from './source';
import {
  clipFrameToSourceIndex,
  cloneMarker,
  enabledMarkerAt,
  insertMarker,
  markerExact,
  type MovieClipData,
  type MovieTrackingMarker,
  type MovieTrackingTrack,
} from './types';

// ---------------------------------------------------------------------------
// worker pool

class Pool {
  private workers: Worker[] = [];
  private pending = new Map<number, (r: WorkerResponse) => void>();
  private id = 0;
  private rr = 0;
  constructor(n: number) {
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const cb = this.pending.get(e.data.id);
        if (cb) {
          this.pending.delete(e.data.id);
          cb(e.data);
        }
      };
      this.workers.push(w);
    }
  }
  get size() {
    return this.workers.length;
  }
  post(req: WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, 'id'> : never) : never, transfer: Transferable[] = []): Promise<WorkerResponse> {
    const id = ++this.id;
    const w = this.workers[this.rr++ % this.workers.length];
    return new Promise((res) => {
      this.pending.set(id, res);
      w.postMessage({ ...req, id }, transfer);
    });
  }
}

let pool: Pool | null | undefined;
function getPool(): Pool | null {
  if (pool !== undefined) return pool;
  try {
    const n = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
    pool = typeof Worker !== 'undefined' ? new Pool(n) : null;
  } catch {
    pool = null;
  }
  return pool;
}

/** Track a batch of items (split across workers). */
export async function runTracker(items: TrackItem[]): Promise<TrackResult[]> {
  const p = getPool();
  if (!p || items.length === 0) return items.length ? handle({ id: 0, type: 'track', items }).results! : [];
  const chunks = Math.min(p.size, items.length);
  const per = Math.ceil(items.length / chunks);
  const parts: Promise<WorkerResponse>[] = [];
  for (let i = 0; i < items.length; i += per) {
    const part = items.slice(i, i + per);
    parts.push(p.post({ type: 'track', items: part }, part.flatMap((it) => [it.ref.data.buffer, it.cur.data.buffer])));
  }
  const out: TrackResult[] = [];
  for (const r of await Promise.all(parts)) {
    if (r.error) throw new Error(r.error);
    out.push(...r.results!);
  }
  return out;
}

export async function runDetector(frame: Gray, opts: DetectOptions): Promise<Feature[]> {
  const p = getPool();
  const copy = { w: frame.w, h: frame.h, data: frame.data.slice() };
  const r = p ? await p.post({ type: 'detect', frame: copy, opts }, [copy.data.buffer]) : handle({ id: 0, type: 'detect', frame: copy, opts });
  if (r.error) throw new Error(r.error);
  return r.features!;
}

// ---------------------------------------------------------------------------
// coordinate helpers (normalized bottom-left ↔ pixel top-left)

export function toPixel(clip: MovieClipData, u: number, v: number): P2 {
  return [u * clip.size[0], (1 - v) * clip.size[1]];
}
export function toNormalized(clip: MovieClipData, x: number, y: number): [number, number] {
  return [x / clip.size[0], 1 - y / clip.size[1]];
}

function markerPixels(clip: MovieClipData, m: MovieTrackingMarker) {
  const [W, H] = clip.size;
  const c = toPixel(clip, m.co[0], m.co[1]);
  const corners = m.pattern_corners.map((p) => [c[0] + p[0] * W, c[1] - p[1] * H] as P2);
  const smin: P2 = [c[0] + m.search_min[0] * W, c[1] - m.search_max[1] * H];
  const smax: P2 = [c[0] + m.search_max[0] * W, c[1] - m.search_min[1] * H];
  return { c, corners, smin, smax };
}

function channels(t: MovieTrackingTrack): ChannelMask {
  return { r: t.use_red_channel, g: t.use_green_channel, b: t.use_blue_channel };
}

function maskKey(m: ChannelMask) {
  return (m.r ? 1 : 0) | (m.g ? 2 : 0) | (m.b ? 4 : 0);
}

/** Reference marker for tracking `track` from frame `f` in a direction. */
export function referenceMarker(track: MovieTrackingTrack, f: number, backwards: boolean): MovieTrackingMarker | null {
  const cur = enabledMarkerAt(track, f);
  if (!cur) return null;
  if (track.pattern_match === 'PREV_FRAME') return cur;
  // nearest keyframed marker at or behind the current frame, in tracking direction
  const ms = track.markers;
  if (!backwards) {
    for (let i = ms.length - 1; i >= 0; i--) {
      const m = ms[i];
      if (m.frame > f) continue;
      if (m.mute) break;
      if (m.is_keyed) return m;
    }
  } else
    for (const m of ms) {
      if (m.frame < f) continue;
      if (m.mute) break;
      if (m.is_keyed) return m;
    }
  return cur;
}

interface Prepared {
  track: MovieTrackingTrack;
  item: TrackItem;
  prev: MovieTrackingMarker;
}

async function frameGray(src: FrameSource, clip: MovieClipData, clipFrame: number, mask: ChannelMask, cache: Map<string, Gray | null>) {
  const key = `${clipFrame}:${maskKey(mask)}`;
  if (cache.has(key)) return cache.get(key)!;
  const g = await src.gray(clipFrameToSourceIndex(clip, clipFrame), mask);
  cache.set(key, g);
  return g;
}

/** Build the tracker work item for one track (ref marker → guess marker at `toFrame`). */
async function prepare(src: FrameSource, clip: MovieClipData, track: MovieTrackingTrack, ref: MovieTrackingMarker, guess: MovieTrackingMarker, toFrame: number, cache: Map<string, Gray | null>): Promise<Prepared | null> {
  const mask = channels(track);
  const refImg = await frameGray(src, clip, ref.frame, mask, cache);
  const curImg = await frameGray(src, clip, toFrame, mask, cache);
  if (!refImg || !curImg) return null;
  const [W, H] = clip.size;
  const r = markerPixels(clip, ref);
  const g = markerPixels(clip, guess);
  const patternHalf = Math.max(...r.corners.map((p) => Math.max(Math.abs(p[0] - r.c[0]), Math.abs(p[1] - r.c[1]))));
  const searchRadius = Math.max(g.smax[0] - g.smin[0], g.smax[1] - g.smin[1]) / 2;
  const levels = pyramidLevels(searchRadius, patternHalf);
  const rx = r.corners.map((p) => p[0]),
    ry = r.corners.map((p) => p[1]);
  const rr = regionRect(Math.min(...rx), Math.min(...ry), Math.max(...rx), Math.max(...ry), W, H, levels);
  const cr = regionRect(g.smin[0], g.smin[1], g.smax[0], g.smax[1], W, H, levels);
  const params: TrackParams = {
    model: track.motion_model,
    refCenter: r.c,
    refCorners: r.corners,
    prevCenter: g.c,
    prevCorners: g.corners,
    searchMin: g.smin,
    searchMax: g.smax,
    frameSize: [W, H],
    useBrute: track.use_brute,
    useNormalization: track.use_normalization,
    correlationMin: track.correlation_min,
    margin: track.margin,
  };
  return { track, prev: guess, item: { ref: cropRegion(refImg, ...rr), cur: cropRegion(curImg, ...cr), levels, params } };
}

function markerFromResult(clip: MovieClipData, prev: MovieTrackingMarker, frame: number, r: TrackResult): MovieTrackingMarker {
  const [W, H] = clip.size;
  const co = toNormalized(clip, r.center[0], r.center[1]);
  return {
    frame,
    co,
    pattern_corners: r.corners.map((p) => [(p[0] - r.center[0]) / W, -(p[1] - r.center[1]) / H]) as MovieTrackingMarker['pattern_corners'],
    search_min: [prev.search_min[0], prev.search_min[1]],
    search_max: [prev.search_max[0], prev.search_max[1]],
    mute: false,
    is_keyed: false,
  };
}

export interface StepOutcome {
  tracked: number;
  failed: string[];
  /** tracks still active after the step */
  active: MovieTrackingTrack[];
  /** the clip stopped being the current one while tracking (nothing was written) */
  stale?: boolean;
}

/**
 * Track the given tracks one frame from clip frame `f` (forward or backward).
 * Writes markers into the tracks; failed tracks get a disabled marker on the next frame.
 */
export async function trackStep(clip: MovieClipData, tracks: MovieTrackingTrack[], f: number, backwards: boolean, isCurrent: () => boolean = () => true): Promise<StepOutcome> {
  const src = await clipSource(clip);
  if (!src) throw new Error('The clip has no footage');
  const next = backwards ? f - 1 : f + 1;
  const cache = new Map<string, Gray | null>();
  const prepared: Prepared[] = [];
  for (const t of tracks) {
    const cur = enabledMarkerAt(t, f);
    const ref = referenceMarker(t, f, backwards);
    if (!cur || !ref) continue;
    const p = await prepare(src, clip, t, ref, cur, next, cache);
    if (p) prepared.push(p);
  }
  const results = await runTracker(prepared.map((p) => p.item));
  // the document was replaced meanwhile (undo, file load): the results belong to an old copy
  if (!isCurrent()) return { tracked: 0, failed: [], active: [], stale: true };
  const out: StepOutcome = { tracked: 0, failed: [], active: [] };
  prepared.forEach((p, i) => {
    const r = results[i];
    const t = p.track;
    t.last_correlation = r.correlation;
    const existing = markerExact(t, next);
    if (r.ok) {
      out.tracked++;
      out.active.push(t);
      if (existing?.is_keyed && !existing.mute) return; // never overwrite a user keyframe
      insertMarker(t, markerFromResult(clip, p.prev, next, r));
    } else {
      out.failed.push(t.name);
      if (existing?.is_keyed && !existing.mute) return;
      const dis = cloneMarker(p.prev, next);
      dis.mute = true;
      dis.is_keyed = false;
      insertMarker(t, dis);
    }
  });
  return out;
}

/** Re-run the tracker from each track's reference keyframe directly to the current frame. */
export async function refineMarkers(clip: MovieClipData, tracks: MovieTrackingTrack[], f: number, backwards: boolean, isCurrent: () => boolean = () => true): Promise<number> {
  const src = await clipSource(clip);
  if (!src) return 0;
  const cache = new Map<string, Gray | null>();
  const prepared: Prepared[] = [];
  for (const t of tracks) {
    const cur = markerExact(t, f);
    if (!cur || cur.mute) continue;
    let ref: MovieTrackingMarker | null = null;
    const ms = t.markers;
    if (!backwards) {
      for (let i = ms.length - 1; i >= 0; i--) if (ms[i].frame < f && ms[i].is_keyed && !ms[i].mute) {
        ref = ms[i];
        break;
      }
    } else for (const m of ms) if (m.frame > f && m.is_keyed && !m.mute) {
      ref = m;
      break;
    }
    if (!ref) continue;
    const p = await prepare(src, clip, t, ref, cur, f, cache);
    if (p) prepared.push(p);
  }
  const results = await runTracker(prepared.map((p) => p.item));
  if (!isCurrent()) return 0;
  let n = 0;
  prepared.forEach((p, i) => {
    if (!results[i].ok) return;
    const m = markerFromResult(clip, p.prev, f, results[i]);
    m.is_keyed = p.prev.is_keyed;
    insertMarker(p.track, m);
    n++;
  });
  return n;
}

/** Detect features in a clip frame; returns pixel positions (top-left origin). */
export async function detectInFrame(clip: MovieClipData, clipFrame: number, opts: DetectOptions): Promise<Feature[]> {
  const src = await clipSource(clip);
  if (!src) return [];
  const g = await src.gray(clipFrameToSourceIndex(clip, clipFrame));
  if (!g) return [];
  return runDetector(g, opts);
}
