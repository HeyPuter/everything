/**
 * Make an object removal region follow what it covers: the region's bounds
 * at the playhead are tracked forward and backward through the clip's own
 * video (media/tracker.js), and the region gets position keyframes that move
 * with the object.
 */
import { US } from '../lib/time.js';
import * as T from '../model/timeline.js';
import { evaluateRegions, followKeys, regionBounds, regionProp } from '../model/removal.js';
import { Tracker, grayFrames } from '../media/tracker.js';
import { thinKeys } from '../media/reframe.js';

const FPS = 15;
const TW = 320;

/** Tracking frame size for a source aspect (width / height). */
export function trackSize(aspect) {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 9;
  return a >= 1 ? { tw: TW, th: Math.max(48, Math.round(TW / a)) } : { tw: Math.max(48, Math.round(TW * a)), th: TW };
}

/** Box to track in tracking-frame pixels for region bounds (fractions), at least 12 pixels a side. */
export function trackBox(bounds, tw, th) {
  const cx = (bounds.x + bounds.w / 2) * tw;
  const cy = (bounds.y + bounds.h / 2) * th;
  const w = Math.max(12, bounds.w * tw);
  const h = Math.max(12, bounds.h * th);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** Clip-local times to track: forward from t0 to the end, then backward to the start. */
export function trackTimes(t0, duration, fps = FPS) {
  const step = US / fps;
  const fwd = [];
  for (let t = t0; t < duration; t += step) fwd.push(Math.round(t));
  const back = [];
  for (let t = t0 - step; t >= 0; t -= step) back.push(Math.round(t));
  return { fwd, back };
}

/**
 * Track region index of a video clip from the playhead. Resolves to the
 * number of keyframes written; onProgress gets 0..1. Abort with signal.
 * frames (tests) replaces reading the video: async (srcTimes, size) =>
 * iterable of { frame }.
 */
export async function followRegion(ctx, clipId, index, { signal, onProgress, frames = null } = {}) {
  const { store } = ctx;
  const f = T.findClip(store.project, clipId);
  if (!f || f.clip.type !== 'video') throw new Error('Only video clips can follow motion.');
  const clip = f.clip;
  const asset = store.project.assets[clip.assetId];
  const aspect = (asset?.width || 16) / (asset?.height || 9);
  const t0 = Math.round(Math.min(clip.duration - 1, Math.max(0, store.time - clip.start)));
  const region = evaluateRegions(clip, t0)[index];
  const bounds = region && regionBounds(region, aspect);
  if (!bounds) throw new Error('Paint or draw the region first.');
  const { tw, th } = trackSize(aspect);
  const box = trackBox(bounds, tw, th);
  const { fwd, back } = trackTimes(t0, clip.duration);
  const total = fwd.length + back.length || 1;
  let done = 0;
  const points = [];
  const read = frames || (async (srcTimes) => grayFrames(await ctx.library.mediaBlob(asset), srcTimes, { tw, th, signal }));
  const run = async (times, skipFirst = false) => {
    if (!times.length) return;
    let tracker = null;
    let i = 0;
    const srcTimes = times.map((t) => T.sourceTimeAt(clip, clip.start + t));
    for await (const { t: st, frame } of await read(srcTimes, { tw, th })) {
      if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
      // Frames that could not be read are skipped; line up with the time read.
      while (st !== undefined && i < srcTimes.length - 1 && srcTimes[i] !== st) i++;
      const t = times[i++];
      let c;
      if (!tracker) {
        tracker = new Tracker(frame, tw, th, box);
        c = tracker.center;
      } else c = tracker.step(frame);
      if (skipFirst && i === 1) continue;
      points.push({ t, x: c.x / tw, y: c.y / th });
      onProgress?.(++done / total);
    }
  };
  await run(fwd);
  // Backward pass starts again from the region at the playhead.
  if (back.length) await run([t0, ...back], true);
  const keys = followKeys(region, points, t0, (k) => thinKeys(k, 0.0015));
  if (!keys) return 0;
  ctx.actions.editClip(clip.id, 'Follow motion', (c) => {
    if (!c.removal?.regions?.[index]) return false;
    c.keyframes ||= {};
    c.keyframes[regionProp(index, 'x')] = keys.x;
    c.keyframes[regionProp(index, 'y')] = keys.y;
  });
  return keys.x.length + keys.y.length;
}
