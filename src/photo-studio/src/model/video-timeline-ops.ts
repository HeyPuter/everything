// Video timeline operations (loaded with the timeline commands): time
// labels, clip edits, keyframe edits, placing a time into the layers, frame
// rate changes and conversions between frame animations and timelines. The
// model itself is described in video-timeline.ts.
import { allLayers, type Layer, type PhotoDocument } from './document';
import { positionable, newFrameId, frameState, type AnimationFrame, type FrameLayerState } from './animation';
import { commitPixelTranslation, dropLiveFilters, pixelTransformKind, syncPixelTransform } from './pixel-layer';
import { emptyGrid, gridDocBounds, gridFromImage, readRGBA, type TileGrid, type TileStore } from './tiles';
import { footageFrame, placementOf, videoSeconds, type VideoLayerData } from './video-layer';
import { splitLinkedSound } from './audio-timeline';
import { mat3Multiply, transformedBounds, transformImage, type Mat3 } from '../imaging/filters/warp';
import type { Interp } from '../imaging/filters/sampling';
import {
  canAnimate,
  clipStates,
  contentFrame,
  createTimeline,
  clipEnd,
  keyProperties,
  maxTimelineFrames,
  ownClip,
  presentTimeline,
  setKey,
  valueAt,
  videoFrameAt,
  type Clip,
  type ClipKeys,
  type FrameLookup,
  type Placer,
  type Key,
  type KeyProperty,
  type VideoTimeline,
} from './video-timeline';

// ----- Time -----

export const fpsLabel = (fps: number) => `${Number(fps.toFixed(3))} fps`;
/** Seconds:frames (with hours or minutes when needed), e.g. 0:02:14. */
export function timecode(frame: number, fps: number) {
  const f = Math.max(0, Math.round(frame));
  const per = Math.max(1, Math.round(fps));
  const secs = Math.floor(f / fps + 1e-9);
  const ff = Math.min(per - 1, Math.round(f - secs * fps));
  const h = Math.floor(secs / 3600),
    m = Math.floor((secs % 3600) / 60),
    s = secs % 60;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const fw = String(per - 1).length;
  return `${h ? `${h}:${pad(m)}` : m}:${pad(s)}:${pad(ff, fw)}`;
}
/** A comfortable ruler step in frames for `pxPerFrame`: whole frames,
 * seconds or minutes, at least `minPx` apart. */
export function rulerStep(fps: number, pxPerFrame: number, minPx = 70) {
  const seconds = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].map((s) => Math.round(s * fps));
  const candidates = [...new Set([1, 2, 5, 10, ...seconds])].filter((n) => n >= 1).sort((a, b) => a - b);
  return candidates.find((n) => n * pxPerFrame >= minPx) ?? candidates.at(-1)!;
}

/** Content length in timeline frames: finite for video layers that do not
 * repeat forever, else unbounded. */
export function contentLength(l: Pick<Layer, 'video'>, fps: number) {
  if (!l.video) return Infinity;
  const s = videoSeconds(l.video);
  return Number.isFinite(s) ? Math.max(1, Math.ceil(s * fps - 1e-6)) : Infinity;
}
/** The clip a new layer gets: the whole timeline, or its content length. */
export function naturalClip(tl: VideoTimeline, l: Pick<Layer, 'video'>, start = 0): Clip {
  const n = contentLength(l, tl.fps);
  return { start, in: 0, length: Number.isFinite(n) ? n : Math.max(1, tl.duration - start) };
}

/** Move a clip by `d` frames (its start stays within the timeline). */
export function moveClip(c: Clip, d: number, duration: number): Clip {
  const start = Math.max(0, Math.min(duration - 1, c.start + Math.round(d)));
  return { ...c, start };
}
/** Move the clip's first frame by `d` (positive trims, negative extends);
 * `limit` is the content length (Infinity for still content). */
export function trimClipStart(c: Clip, d: number, limit = Infinity): Clip {
  let start = c.start + Math.round(d);
  start = Math.min(start, c.start + c.length - 1);
  start = Math.max(start, 0);
  // Footage cannot start before its first frame.
  if (Number.isFinite(limit)) start = Math.max(start, c.start - c.in);
  const by = start - c.start;
  return { ...c, start, in: c.in + by, length: c.length - by };
}
/** Move the clip's last frame by `d`. */
export function trimClipEnd(c: Clip, d: number, limit = Infinity): Clip {
  let length = Math.max(1, c.length + Math.round(d));
  if (Number.isFinite(limit)) length = Math.min(length, Math.max(1, limit - c.in));
  return { ...c, length };
}
/** Split a clip at timeline frame `t` into the part before and after it;
 * null when `t` is not inside the clip. Both parts keep the keyframes; the
 * first keeps the fade in and the second the fade out. */
export function splitClip(c: Clip, t: number): [Clip, Clip] | null {
  t = Math.round(t);
  if (t <= c.start || t >= clipEnd(c)) return null;
  const a: Clip = structuredClone({ ...c, length: t - c.start });
  delete a.fadeOut;
  const b: Clip = structuredClone({ ...c, start: t, in: c.in + (t - c.start), length: clipEnd(c) - t });
  delete b.fadeIn;
  return [a, b];
}

/** Split the clips of layers `ids` at timeline frame `t`: each layer is
 * followed by a copy (new IDs) holding the second part, and its linked
 * sound splits with it. Returns the IDs of the copies. */
export function splitLayers(d: PhotoDocument, ids: string[], t: number): string[] {
  const tl = d.timeline!;
  const made: string[] = [];
  for (const id of ids) {
    const parts = splitClip(ownClip(tl, id), t);
    if (!parts) continue;
    const container = containerList(d.layers, id);
    if (!container) continue;
    const i = container.findIndex((l) => l.id === id);
    const copy = cloneLayer(container[i]);
    container.splice(i + 1, 0, copy);
    tl.clips[id] = parts[0];
    tl.clips[copy.id] = parts[1];
    splitLinkedSound(d, id, copy.id);
    made.push(copy.id);
  }
  return made;
}
function containerList(layers: Layer[], id: string): Layer[] | undefined {
  if (layers.some((l) => l.id === id)) return layers;
  for (const l of layers) {
    const found = containerList(l.children, id);
    if (found) return found;
  }
  return undefined;
}
/** A copy of a layer (and its children) with new IDs; tiles are shared. */
function cloneLayer(l: Layer): Layer {
  const copy = structuredClone(l);
  const renew = (x: Layer) => {
    x.id = crypto.randomUUID();
    delete x.psdId;
    x.children.forEach(renew);
  };
  renew(copy);
  return copy;
}
/** Trim the start or end of the clips of layers `ids` to timeline frame
 * `t` (within their content). Returns whether any clip changed. */
export function trimLayers(d: PhotoDocument, ids: string[], edge: 'start' | 'end', t: number) {
  const tl = d.timeline!;
  let changed = false;
  for (const id of ids) {
    const l = allLayers(d.layers).find((x) => x.id === id);
    if (!l) continue;
    const c = ownClip(tl, id);
    const limit = contentLength(l, tl.fps);
    const next = edge === 'start' ? trimClipStart(c, t - c.start, limit) : trimClipEnd(c, t + 1 - clipEnd(c), limit);
    if (JSON.stringify(next) !== JSON.stringify(c)) changed = true;
    tl.clips[id] = next;
  }
  return changed;
}

export function removeKey<T>(keys: Key<T>[], t: number) {
  return keys.filter((k) => k.t !== t);
}
/** Move the key at `from` to `to` (replacing a key already there). */
export function moveKey<T>(keys: Key<T>[], from: number, to: number): Key<T>[] {
  const k = keys.find((x) => x.t === from);
  if (!k || from === to) return keys;
  return [...keys.filter((x) => x.t !== from && x.t !== to), { ...k, t: to }].sort((a, b) => a.t - b.t);
}
export function setInterpolation<T>(keys: Key<T>[], times: number[], hold: boolean): Key<T>[] {
  const set = new Set(times);
  return keys.map((k) => {
    if (!set.has(k.t)) return k;
    const out: Key<T> = { t: k.t, v: k.v };
    if (hold) out.hold = true;
    return out;
  });
}

/** The value a property shows on a layer right now (the next key's value). */
export function currentValue(l: Layer, clip: Clip, prop: KeyProperty): unknown {
  if (prop === 'position') return [...(clip.offset ?? [0, 0])] as [number, number];
  if (prop === 'opacity') return l.opacity;
  return l.style ? structuredClone(l.style) : null;
}
/** Turn a property's stopwatch on (one key at the current time with the
 * current value) or off (the keys go; the layer keeps its current value). */
export function toggleStopwatch(doc: PhotoDocument, id: string, prop: KeyProperty) {
  const tl = doc.timeline!;
  const l = allLayers(doc.layers).find((x) => x.id === id);
  if (!l || !canAnimate(l, prop)) return false;
  const clip = ownClip(tl, id);
  const keys = (clip.keys ??= {});
  if (keys[prop]) {
    delete keys[prop];
    if (!Object.keys(keys).length) delete clip.keys;
  } else (keys as Record<string, Key<unknown>[]>)[prop] = [{ t: contentFrame(clip, tl.current), v: currentValue(l, clip, prop) }];
  return true;
}
/** Add a key with the current value at the current time, or remove the key
 * there. Removing the last key turns the stopwatch off. */
export function toggleKeyAtCurrent(doc: PhotoDocument, id: string, prop: KeyProperty) {
  const tl = doc.timeline!;
  const l = allLayers(doc.layers).find((x) => x.id === id);
  if (!l || !canAnimate(l, prop)) return false;
  const clip = ownClip(tl, id);
  const t = contentFrame(clip, tl.current);
  const keys = (clip.keys ??= {}) as Record<string, Key<unknown>[]>;
  const list = keys[prop];
  if (list?.some((k) => k.t === t)) {
    const rest = removeKey(list, t);
    if (rest.length) keys[prop] = rest;
    else delete keys[prop];
  } else keys[prop] = setKey(list ?? [], t, currentValue(l, clip, prop));
  if (!Object.keys(keys).length) delete clip.keys;
  return true;
}
/** Timeline frames of a layer's keys for one property (or all), sorted. */
export function keyTimes(tl: VideoTimeline, id: string, prop?: KeyProperty): number[] {
  const clip = tl.clips[id];
  if (!clip?.keys) return [];
  const lists = prop ? [clip.keys[prop]] : keyProperties.map((p) => clip.keys![p]);
  const out = new Set<number>();
  for (const list of lists) for (const k of list ?? []) out.add(k.t - clip.in + clip.start);
  return [...out].sort((a, b) => a - b);
}

// ----- Placing a time into the layers -----

/** The grid a video layer shows for layer frame `k` (an altered frame, a
 * blank frame or a decoded footage frame) and its document matrix. */
export function videoGrid(tl: VideoTimeline, v: VideoLayerData, k: number, l: Layer, lookup?: FrameLookup): { grid: TileGrid; matrix: Mat3; altered: boolean } | undefined {
  const altered = tl.hideAltered ? undefined : v.altered?.[k];
  if (altered) return { grid: altered, matrix: placementOf(v, true, k), altered: true };
  const j = footageFrame(v, k);
  const grid = j < 0 ? emptyGrid(4) : lookup?.(l, k, j);
  return grid && { grid, matrix: placementOf(v, false), altered: false };
}
/** A placer that resamples with `method` (exact for whole-pixel moves). */
export function resamplePlacer(store: TileStore, method: Interp = 'bicubic'): Placer {
  return (grid, m) => {
    const b = gridDocBounds(grid);
    if (!b) return emptyGrid(4);
    const mm = mat3Multiply(m, [1, 0, b.x, 0, 1, b.y, 0, 0, 1]);
    const out = transformedBounds(mm, b.width, b.height);
    return gridFromImage(store, transformImage(readRGBA(store, grid, b), mm, out, method), out.x, out.y);
  };
}
/** Footage frames the layers need at timeline frame `t` (for decoding ahead). */
export function neededFrames(doc: PhotoDocument, t: number): { layer: Layer & { video: VideoLayerData }; k: number; source: number }[] {
  const tl = doc.timeline;
  if (!tl) return [];
  const states = clipStates(doc, t);
  const out: { layer: Layer & { video: VideoLayerData }; k: number; source: number }[] = [];
  for (const l of allLayers(doc.layers)) {
    if (!l.video) continue;
    const s = states.get(l.id);
    if (s && !s.shown) continue;
    const k = videoFrameAt(tl, l as Layer & { video: VideoLayerData }, s?.content ?? t);
    if (!tl.hideAltered && l.video.altered?.[k]) continue;
    const source = footageFrame(l.video, k);
    if (source >= 0) out.push({ layer: l as Layer & { video: VideoLayerData }, k, source });
  }
  return out;
}

// Pixel layers live on the pixel grid: offsets apply rounded.
const offsetOf = (l: Layer, v: number) => (l.kind === 'pixel' ? Math.round(v) : v);

/** Show timeline frame `t`: keyed values and video frames go into the layers.
 * Video frames that `lookup` does not have yet keep the frame shown. */
export function applyTime(doc: PhotoDocument, t: number, lookup?: FrameLookup) {
  const tl = doc.timeline;
  if (!tl || !Number.isFinite(t)) return;
  t = Math.max(0, Math.min(tl.duration - 1, Math.round(t)));
  const states = clipStates(doc, t);
  for (const l of allLayers(doc.layers)) {
    const clip = tl.clips[l.id];
    const content = states.get(l.id)?.content ?? t;
    const keys = clip?.keys;
    if (clip && keys?.position && positionable(l)) {
      const v = valueAt(keys.position, content);
      const was = clip.offset ?? [0, 0];
      const dx = offsetOf(l, v[0]) - offsetOf(l, was[0]),
        dy = offsetOf(l, v[1]) - offsetOf(l, was[1]);
      if (dx || dy) {
        l.transform = { ...l.transform, x: l.transform.x + dx, y: l.transform.y + dy };
        if (l.video) l.video = { ...l.video, x: l.video.x + dx, y: l.video.y + dy };
      }
      if (v[0] || v[1]) clip.offset = [v[0], v[1]];
      else delete clip.offset;
    }
    if (keys?.opacity) l.opacity = Math.max(0, Math.min(1, valueAt(keys.opacity, content)));
    if (keys?.style) {
      const s = valueAt(keys.style, content);
      if (s) l.style = structuredClone(s);
      else delete l.style;
    }
    if (l.video && l.kind === 'pixel') placeVideoFrame(doc, l as Layer & { video: VideoLayerData }, videoFrameAt(tl, l as Layer & { video: VideoLayerData }, content), lookup);
  }
  tl.current = t;
  tl.placed = true;
}
/** Put layer frame `k` into a video layer's pixels. */
export function placeVideoFrame(doc: PhotoDocument, l: Layer & { video: VideoLayerData }, k: number, lookup?: FrameLookup) {
  const src = videoGrid(doc.timeline!, l.video, k, l, lookup);
  if (!src) return false;
  const { grid, matrix: m } = src;
  // Whole-pixel moves place the grid as it is; other placements resample.
  const shift = m[0] === 1 && m[1] === 0 && m[3] === 0 && m[4] === 1 && m[6] === 0 && m[7] === 0 && m[8] === 1 && Number.isInteger(m[2]) && Number.isInteger(m[5]);
  const placed = shift ? { ...grid, x: grid.x + m[2], y: grid.y + m[5] } : grid.bounds ? lookup?.place?.(grid, m) : { ...emptyGrid(4), x: l.video.x, y: l.video.y };
  if (!placed) return false;
  // Live Filters were rendered from another frame.
  dropLiveFilters(l);
  if (l.pixels && pixelTransformKind(l) === 'translate') commitPixelTranslation(l);
  l.pixels = placed;
  syncPixelTransform(l, doc);
  return true;
}
/** A copy of the document showing timeline frame `t` (rendering, export). */
export function timeDocument(doc: PhotoDocument, t: number, lookup?: FrameLookup): PhotoDocument {
  const copy = structuredClone(doc);
  applyTime(copy, t, lookup);
  delete copy.timeline!.placed;
  for (const l of allLayers(copy.layers)) if (l.kind === 'pixel' && l.pixels && pixelTransformKind(l) === 'translate') commitPixelTranslation(l);
  return copy;
}

// ----- Frame rate -----

/** Change the frame rate, keeping every time in seconds. */
export function setTimelineFps(tl: VideoTimeline, fps: number) {
  const k = fps / tl.fps;
  if (!Number.isFinite(k) || k <= 0 || k === 1) return;
  const r = (n: number) => Math.round(n * k);
  const len = (n: number) => Math.max(1, Math.round(n * k));
  tl.duration = Math.min(maxTimelineFrames, len(tl.duration));
  tl.current = Math.min(tl.duration - 1, r(tl.current));
  if (tl.work) tl.work = [r(tl.work[0]), Math.max(r(tl.work[0]) + 1, r(tl.work[1]))];
  for (const c of Object.values(tl.clips)) {
    c.start = r(c.start);
    c.in = r(c.in);
    c.length = len(c.length);
    for (const tr of [c.fadeIn, c.fadeOut]) if (tr) tr.duration = len(tr.duration);
    for (const p of keyProperties) {
      const list = c.keys?.[p] as Key<unknown>[] | undefined;
      if (!list) continue;
      const seen = new Map<number, Key<unknown>>();
      for (const key of list) seen.set(r(key.t), { ...key, t: r(key.t) });
      (c.keys as Record<string, Key<unknown>[]>)[p] = [...seen.values()].sort((a, b) => a.t - b.t);
    }
  }
  tl.fps = fps;
}
export const workArea = (tl: VideoTimeline): [number, number] => {
  const [a, b] = tl.work ?? [0, tl.duration];
  const s = Math.max(0, Math.min(tl.duration - 1, a));
  return [s, Math.max(s + 1, Math.min(tl.duration, b))];
};

// ----- Conversions -----

/** Replace a frame animation with a video timeline: each frame lasts its
 * delay; per-frame visibility becomes clip ranges (gaps hold opacity 0), and
 * per-frame position, opacity and style become hold keyframes. */
export function animationToTimeline(doc: PhotoDocument, fps = 30) {
  const anim = doc.animation;
  if (!anim) return false;
  const starts: number[] = [];
  let ms = 0,
    last = -1;
  for (const f of anim.frames) {
    const s = Math.max(last + 1, Math.round((ms * fps) / 1000));
    starts.push(s);
    last = s;
    ms += f.delay;
  }
  const end = Math.max(last + 1, Math.round((ms * fps) / 1000));
  const ends = starts.map((_, i) => starts[i + 1] ?? end);
  const tl = createTimeline(fps);
  tl.duration = Math.max(1, end);
  tl.current = starts[anim.current];
  for (const l of allLayers(doc.layers)) {
    const states = anim.frames.map((f) => f.layers[l.id]).filter((s): s is FrameLayerState => !!s);
    if (states.length !== anim.frames.length) continue;
    const visible = states.map((s) => s.visible);
    const first = visible.indexOf(true),
      lastVisible = visible.lastIndexOf(true);
    if (first < 0) {
      l.visible = false;
      continue;
    }
    const range = states.slice(first, lastVisible + 1);
    const clip: Clip = { start: starts[first], in: starts[first], length: ends[lastVisible] - starts[first] };
    const keys: ClipKeys = {};
    const differ = <T>(f: (s: FrameLayerState) => T) => new Set(range.map((s) => JSON.stringify(f(s)))).size > 1;
    if (differ((s) => (s.visible ? s.opacity : 0))) keys.opacity = range.map((s, i) => ({ t: starts[first + i], v: s.visible ? s.opacity : 0, hold: true as const }));
    if (positionable(l) && differ((s) => [s.dx, s.dy])) {
      keys.position = range.map((s, i) => ({ t: starts[first + i], v: [s.dx, s.dy] as [number, number], hold: true as const }));
      const cur = anim.frames[anim.current].layers[l.id];
      if (cur.dx || cur.dy) clip.offset = [cur.dx, cur.dy];
    }
    if (l.kind !== 'adjustment' && differ((s) => s.style ?? null)) keys.style = range.map((s, i) => ({ t: starts[first + i], v: s.style ? structuredClone(s.style) : null, hold: true as const }));
    if (Object.keys(keys).length) clip.keys = keys;
    if (first > 0 || lastVisible < states.length - 1 || clip.keys) tl.clips[l.id] = clip;
    l.visible = true;
    if (keys.opacity) l.opacity = valueAt(keys.opacity, tl.current);
  }
  delete doc.animation;
  doc.timeline = tl;
  return true;
}

/** Replace the video timeline with a frame animation sampled at `times`
 * (timeline frames). The document should show `times[current]`. Video layers
 * become one pixel layer per sampled frame (`makeLayer` builds it), shown
 * only in its frame. */
export function timelineToAnimation(
  doc: PhotoDocument,
  times: number[],
  current: number,
  delay: number,
  lookup: FrameLookup,
  makeLayer: (name: string, grid: TileGrid, from: Layer) => Layer,
) {
  const tl = doc.timeline;
  if (!tl || !times.length) return false;
  const layers = allLayers(doc.layers);
  const base = new Map(layers.map((l) => [l.id, structuredClone(l)]));
  const frames: AnimationFrame[] = times.map(() => ({ id: newFrameId(), delay, layers: {} }));
  const added = new Map<string, Layer[]>();
  times.forEach((t, i) => {
    const at = timeDocument(doc, t, lookup);
    const shown = presentTimeline(at);
    const shownById = new Map(allLayers(shown.layers).map((l) => [l.id, l]));
    for (const l of allLayers(at.layers)) {
      const p = shownById.get(l.id) ?? l;
      const b = base.get(l.id)!;
      const dx = positionable(l) ? l.transform.x - b.transform.x : 0,
        dy = positionable(l) ? l.transform.y - b.transform.y : 0;
      const state: FrameLayerState = { visible: p.visible, dx, dy, opacity: p.opacity, blend: p.blend, ...(p.fillOpacity !== undefined ? { fillOpacity: p.fillOpacity } : {}), ...(p.style ? { style: p.style } : {}) };
      if (l.video && l.pixels) {
        // The frame shown becomes its own layer, visible only here.
        const made = makeLayer(`${l.name} ${i + 1}`, l.pixels, l);
        (added.get(l.id) ?? added.set(l.id, []).get(l.id)!).push(made);
        frames.forEach((f, j) => (f.layers[made.id] = frameState({ ...state, dx: 0, dy: 0, visible: j === i && state.visible })));
        frames[i].layers[l.id] = frameState({ ...state, visible: false });
      } else frames[i].layers[l.id] = frameState(state);
    }
  });
  // Replace each video layer by its frames (in its place in the stack).
  const replace = (list: Layer[]): Layer[] =>
    list.flatMap((l) => {
      if (l.children.length) l.children = replace(l.children);
      return l.video ? (added.get(l.id) ?? []) : [l];
    });
  doc.layers = replace(doc.layers);
  for (const f of frames) for (const id of Object.keys(f.layers)) if (!allLayers(doc.layers).some((l) => l.id === id)) delete f.layers[id];
  delete doc.timeline;
  doc.animation = { frames, current, loop: 0 };
  // Show the current frame's records.
  const cur = frames[current];
  for (const l of allLayers(doc.layers)) {
    const s = cur.layers[l.id];
    if (!s) continue;
    l.visible = s.visible;
    l.opacity = s.opacity;
    if (s.style) l.style = structuredClone(s.style);
    else delete l.style;
  }
  return true;
}
