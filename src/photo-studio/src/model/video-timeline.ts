// Video timeline: a time-based alternative to the frame animation (a document
// has one or the other). Time is counted in timeline frames at the
// document's frame rate. Every layer has a clip (absent records span the
// whole duration) that says when it is shown and which part of its content
// plays, plus optional keyframes for position, opacity and layer style and
// transitions at its ends.
//
// As with frame animation, the document's layers show the current time:
// `applyTime` writes keyframed values and video frames into the layers, and
// `syncTimeline` (run on every new history state) records edits made at the
// current time: keyframes for properties whose stopwatch is on, and altered
// frames of video layers. Clip ranges and transitions are applied when the
// document is drawn (`presentTimeline`), so the Layers panel keeps showing
// each layer's own visibility and opacity.
//
// This module holds what runs at any time (drawing, recording edits,
// validating projects); editing operations, placing times and conversions
// are in video-timeline-ops.ts, which loads with the timeline commands.
import { allLayers, type Layer, type PhotoDocument } from './document';
import { moveDelta, positionable, tweenValue, type OnionSkin, onionBlends } from './animation';
import { hasArtboards } from './artboard';
import { dropLiveFilters } from './pixel-layer';
import type { TileGrid } from './tiles';
import { frameAtSeconds, type VideoLayerData } from './video-layer';
import { syncAudio, validateAudio, type AudioTrack } from './audio-timeline';

export type Key<T> = { t: number; v: T; hold?: true };
export type KeyProperty = 'position' | 'opacity' | 'style';
export const keyProperties: KeyProperty[] = ['position', 'opacity', 'style'];
export type LayerStyleValue = Record<string, unknown> | null;
export type ClipKeys = {
  // Offsets in document pixels added to the layer's own position.
  position?: Key<[number, number]>[];
  opacity?: Key<number>[];
  style?: Key<LayerStyleValue>[];
};
export type TransitionKind = 'fade' | 'fade-color' | 'cross-fade';
export const transitionKinds: [TransitionKind, string][] = [
  ['fade', 'Fade'],
  ['fade-color', 'Fade with Color'],
  ['cross-fade', 'Cross Fade'],
];
export type Transition = { kind: TransitionKind; duration: number; color?: string };
export type Clip = {
  // Timeline frame where the clip begins.
  start: number;
  // Content frames trimmed from the beginning (keyframe times count from the
  // content's start, so they stay with the content when the clip moves).
  in: number;
  length: number;
  keys?: ClipKeys;
  fadeIn?: Transition;
  fadeOut?: Transition;
  // Position offset currently applied to the layer (from position keys).
  offset?: [number, number];
};
export type VideoTimeline = {
  fps: number;
  // Frames.
  duration: number;
  current: number;
  // Work area [start, end): playback loops and rendering default to it.
  work?: [number, number];
  clips: Record<string, Clip>;
  onion?: OnionSkin;
  // Show the original footage of altered frames.
  hideAltered?: boolean;
  // Audio tracks under the video tracks (model/audio-timeline.ts).
  audio?: AudioTrack[];
  // Set by `applyTime` for the history hook (never saved): the edit placed
  // time-dependent state and must not be recorded as a user edit.
  placed?: boolean;
};

export const frameRates = [8, 10, 12, 12.5, 15, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
export const maxTimelineFrames = 100_000;
export const defaultTransitionFrames = (fps: number) => Math.max(1, Math.round(fps));
export const artboardConflict = 'Artboards and a video timeline cannot be used in the same document. Convert the artboards to groups, or delete the video timeline first.';

/** A new timeline of `seconds` at `fps`. */
export function createTimeline(fps = 30, seconds = 5): VideoTimeline {
  return { fps, duration: Math.max(1, Math.round(seconds * fps)), current: 0, clips: {} };
}

// ----- Clips -----

export const defaultClip = (tl: Pick<VideoTimeline, 'duration'>): Clip => ({ start: 0, in: 0, length: tl.duration });
export const clipOf = (tl: VideoTimeline, id: string): Clip => tl.clips[id] ?? defaultClip(tl);
/** The clip record of a layer, created when it has none. */
export function ownClip(tl: VideoTimeline, id: string): Clip {
  return (tl.clips[id] ??= defaultClip(tl));
}
export const clipEnd = (c: Clip) => c.start + c.length;
/** Content frame shown at timeline frame `t`. */
export const contentFrame = (c: Clip, t: number) => t - c.start + c.in;

// ----- Keyframes -----

/** Interpolate between key values (linear for numbers and number lists,
 * layer styles through their numeric settings). */
export function interpolate<T>(a: T, b: T, f: number): T {
  if (a === null || b === null) return (f < 1 ? a : b) as T;
  return tweenValue(a, b, f) as T;
}
/** Value of a keyframed property at content frame `t`. */
export function valueAt<T>(keys: Key<T>[], t: number): T {
  if (!keys.length) throw new Error('No keyframes.');
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].t <= t) i++;
  const a = keys[i],
    b = keys[i + 1];
  if (a.hold) return a.v;
  return interpolate(a.v, b.v, (t - a.t) / (b.t - a.t));
}
/** Set (or replace) the key at `t`, keeping keys in time order. */
export function setKey<T>(keys: Key<T>[], t: number, v: T): Key<T>[] {
  const out = keys.filter((k) => k.t !== t);
  const old = keys.find((k) => k.t === t);
  out.push({ t, v, ...(old?.hold ? { hold: true as const } : {}) });
  return out.sort((a, b) => a.t - b.t);
}
/** Whether a layer can animate a property. */
export function canAnimate(l: Layer, prop: KeyProperty) {
  return prop === 'position' ? positionable(l) && !l.background : prop === 'style' ? l.kind !== 'adjustment' : true;
}
// ----- Transitions and clip states at a time -----

export type ClipState = {
  // Inside the clip (or a cross fade's overlap).
  shown: boolean;
  // Opacity multiplier from fades.
  factor: number;
  // Color mixed over the layer by a fade with color.
  tint?: { color: string; amount: number };
  // Content frame shown.
  content: number;
};
function fadeShare(local: number, d: number) {
  return Math.max(0, Math.min(1, local / Math.max(1, d)));
}
/** States of every layer with a clip at timeline frame `t` (layers without a
 * clip record span the whole timeline and are left out). */
export function clipStates(doc: PhotoDocument, t: number): Map<string, ClipState> {
  const tl = doc.timeline!;
  const out = new Map<string, ClipState>();
  const visit = (list: Layer[]) => {
    for (const l of list) {
      const c = tl.clips[l.id];
      if (c) {
        const local = t - c.start;
        const s: ClipState = { shown: local >= 0 && local < c.length, factor: 1, content: contentFrame(c, t) };
        if (s.shown) {
          for (const [edge, tr] of [['in', c.fadeIn], ['out', c.fadeOut]] as const) {
            if (!tr || (edge === 'in' && tr.kind === 'cross-fade' && crossPartner(tl, list, l))) continue;
            const d = Math.min(tr.duration, c.length);
            const pos = edge === 'in' ? local : c.length - 1 - local;
            if (pos >= d) continue;
            const p = fadeShare(pos, d);
            if (tr.kind === 'fade-color' && l.kind !== 'adjustment') s.tint = { color: tr.color ?? '#000000', amount: Math.max(s.tint?.amount ?? 0, 1 - p) };
            else s.factor *= p;
          }
        }
        out.set(l.id, s);
      }
      if (l.children.length) visit(l.children);
    }
    // Cross fades: both clips show over the overlap and the upper one fades.
    for (const b of list) {
      const cb = tl.clips[b.id];
      if (cb?.fadeIn?.kind !== 'cross-fade') continue;
      const a = crossPartner(tl, list, b);
      if (!a) continue;
      const ca = tl.clips[a.id]!;
      const d = Math.max(1, cb.fadeIn.duration);
      const w0 = cb.start - Math.floor(d / 2);
      if (t < w0 || t >= w0 + d) continue;
      const share = (t - w0 + 1) / (d + 1);
      const sa = out.get(a.id)!,
        sb = out.get(b.id)!;
      sa.shown = sb.shown = true;
      if (list.indexOf(b) > list.indexOf(a)) sb.factor *= share;
      else sa.factor *= 1 - share;
      sa.content = contentFrame(ca, t);
      sb.content = contentFrame(cb, t);
    }
  };
  visit(doc.layers);
  return out;
}
/** The sibling whose clip ends where `b`'s clip starts (nearest in the stack). */
export function crossPartner(tl: VideoTimeline, siblings: Layer[], b: Layer): Layer | undefined {
  const cb = tl.clips[b.id];
  if (!cb) return undefined;
  const i = siblings.indexOf(b);
  return siblings
    .filter((a) => a !== b && tl.clips[a.id] && clipEnd(tl.clips[a.id]) === cb.start)
    .sort((x, y) => Math.abs(siblings.indexOf(x) - i) - Math.abs(siblings.indexOf(y) - i))[0];
}

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0) as [number, number, number];
/** A layer style with a color overlay mixing `color` over the layer. */
export function tintStyle(style: Record<string, unknown> | undefined, color: string, amount: number): Record<string, unknown> {
  const base = style && style.enabled !== false ? style : { enabled: true };
  const overlays = Array.isArray(base.colorOverlay) ? (base.colorOverlay as unknown[]) : [];
  return { ...base, enabled: true, colorOverlay: [...overlays, { enabled: true, blendMode: 'normal', opacity: Math.max(0, Math.min(1, amount)), color: rgb(color) }] };
}

const presented = new WeakMap<PhotoDocument, PhotoDocument>();
/** The document as drawn at its current time: layers outside their clips are
 * hidden and transitions fade or tint them. Other documents pass through. */
export function presentTimeline(doc: PhotoDocument): PhotoDocument {
  const tl = doc.timeline;
  if (!tl) return doc;
  const hit = presented.get(doc);
  if (hit) return hit;
  const states = clipStates(doc, tl.current);
  let changed = false;
  const map = (layers: Layer[]): Layer[] =>
    layers.map((l) => {
      let out = l;
      const s = states.get(l.id);
      if (s && (!s.shown || s.factor < 1 || s.tint)) {
        out = { ...l };
        if (!s.shown) out.visible = false;
        else {
          out.opacity = l.opacity * s.factor;
          if (s.tint && s.tint.amount > 0) out.style = tintStyle(l.style, s.tint.color, s.tint.amount);
        }
      }
      if (l.children.length && out.visible) {
        const kids = map(l.children);
        if (kids.some((k, i) => k !== l.children[i])) out = { ...out, children: kids };
      }
      if (out !== l) changed = true;
      return out;
    });
  const layers = map(doc.layers);
  const result = changed ? { ...doc, layers } : doc;
  presented.set(doc, result);
  return result;
}

// ----- Video frames at a time -----

/** A decoded footage frame of a video layer (layer frame `k`, footage frame
 * `source`), or undefined when it is not decoded yet. */
export type FrameLookup = ((l: Layer, k: number, source: number) => TileGrid | undefined) & {
  // Resamples a frame grid through a document matrix (frames of transformed
  // video layers); without it such frames keep the frame shown.
  place?: Placer;
};
/** A frame grid (in its own coordinates) resampled into the document through `m`. */
export type Placer = (grid: TileGrid, m: import('../imaging/filters/warp').Mat3) => TileGrid | undefined;

/** Layer frame of a video layer at timeline frame `t`. */
export function videoFrameAt(tl: VideoTimeline, l: Layer & { video: VideoLayerData }, content: number) {
  return frameAtSeconds(l.video, content / tl.fps);
}
// ----- Recording edits -----

const sameTiles = (a: TileGrid, b: TileGrid) => JSON.stringify(a.tiles) === JSON.stringify(b.tiles) && JSON.stringify(a.bounds) === JSON.stringify(b.bounds);
const videoContent = (v: VideoLayerData | undefined) => (v ? JSON.stringify({ ...v, x: 0, y: 0 }) : '');

/** Record an edit made at the current time (see the file comment). Throws
 * when an edit would combine artboards with a video timeline. */
export function syncTimeline(after: PhotoDocument, before?: PhotoDocument) {
  const tl = after.timeline;
  if (!tl) return;
  const placed = !!tl.placed;
  delete tl.placed;
  if (hasArtboards(after) && !(before?.timeline && hasArtboards(before))) throw new Error(artboardConflict);
  tl.duration = Math.max(1, Math.min(maxTimelineFrames, Math.round(tl.duration) || 1));
  tl.current = Math.max(0, Math.min(tl.duration - 1, Math.round(tl.current) || 0));
  const live = allLayers(after.layers);
  const ids = new Set(live.map((l) => l.id));
  for (const id of Object.keys(tl.clips)) if (!ids.has(id)) delete tl.clips[id];
  syncAudio(after, before);
  const prev = before?.timeline;
  if (!before || !prev) return;
  const old = new Map(allLayers(before.layers).map((l) => [l.id, l]));
  const sameTime = prev.current === tl.current;
  let states: Map<string, ClipState> | undefined;
  for (const l of live) {
    const b = old.get(l.id);
    // Video layers: the frame origin follows moves; content edits at the
    // same time alter the frame shown.
    if (!placed && b && l.video && b.video && l.pixels && b.pixels && l.kind === 'pixel') {
      if (sameTiles(l.pixels, b.pixels)) {
        if (l.pixels.x !== b.pixels.x || l.pixels.y !== b.pixels.y) l.video = { ...l.video, x: b.video.x + l.pixels.x - b.pixels.x, y: b.video.y + l.pixels.y - b.pixels.y };
      } else if (sameTime && videoContent(l.video) === videoContent(b.video)) {
        states ??= clipStates(after, tl.current);
        const k = videoFrameAt(tl, l as Layer & { video: VideoLayerData }, states.get(l.id)?.content ?? tl.current);
        // The shown pixels are in document space: the frame is stored at the
        // layer origin with no matrix of its own.
        l.video = { ...l.video, altered: { ...l.video.altered, [k]: { ...l.pixels, x: l.pixels.x - l.video.x, y: l.pixels.y - l.video.y } } };
        if (l.video.alteredMatrix?.[k]) {
          const rest = { ...l.video.alteredMatrix };
          delete rest[k];
          l.video.alteredMatrix = rest;
          if (!Object.keys(rest).length) delete l.video.alteredMatrix;
        }
        dropLiveFilters(l);
      }
    }
  }
  // Keyframes: only while the same time stays shown on the same canvas, and
  // not when the edit itself changed the keys.
  if (placed || !sameTime || before.width !== after.width || before.height !== after.height) return;
  for (const l of live) {
    const b = old.get(l.id);
    const clip = tl.clips[l.id];
    if (!b || !clip?.keys || JSON.stringify(prev.clips[l.id]?.keys) !== JSON.stringify(clip.keys)) continue;
    const t = contentFrame(clip, tl.current);
    const keys = clip.keys;
    if (keys.position && positionable(l)) {
      const moved = moveDelta(b, l);
      if (moved) {
        const was = clip.offset ?? [0, 0];
        const v: [number, number] = [was[0] + moved[0], was[1] + moved[1]];
        keys.position = setKey(keys.position, t, v);
        clip.offset = v;
      }
    }
    if (keys.opacity && l.opacity !== b.opacity) keys.opacity = setKey(keys.opacity, t, l.opacity);
    if (keys.style && JSON.stringify(l.style ?? null) !== JSON.stringify(b.style ?? null)) keys.style = setKey(keys.style, t, l.style ? structuredClone(l.style) : null);
  }
}

// ----- Validation (projects) -----

const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
const frameInt = (n: unknown) => Number.isInteger(n) && Math.abs(n as number) <= maxTimelineFrames * 4;
function validateKeys(keys: unknown) {
  if (keys === undefined) return true;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return false;
  for (const [p, list] of Object.entries(keys as Record<string, unknown>)) {
    if (!keyProperties.includes(p as KeyProperty) || !Array.isArray(list) || !list.length || list.length > maxTimelineFrames) return false;
    let prev = -Infinity;
    for (const k of list as Key<unknown>[]) {
      if (!k || !frameInt(k.t) || k.t <= prev || (k.hold !== undefined && k.hold !== true)) return false;
      prev = k.t;
      const v = k.v;
      if (p === 'position' && !(Array.isArray(v) && v.length === 2 && v.every(finite))) return false;
      if (p === 'opacity' && !(finite(v) && (v as number) >= 0 && (v as number) <= 1)) return false;
      if (p === 'style' && !(v === null || (typeof v === 'object' && !Array.isArray(v)))) return false;
    }
  }
  return true;
}
const validTransition = (t: Transition | undefined, edge: 'in' | 'out') =>
  t === undefined ||
  (!!t && transitionKinds.some(([k]) => k === t.kind) && !(edge === 'out' && t.kind === 'cross-fade') && Number.isInteger(t.duration) && t.duration >= 1 && t.duration <= maxTimelineFrames && (t.color === undefined || /^#[0-9a-f]{6}$/i.test(t.color)));
export function validateTimeline(value: unknown) {
  const bad = () => new Error('Invalid video timeline.');
  const tl = value as VideoTimeline;
  if (!tl || typeof tl !== 'object' || !finite(tl.fps) || tl.fps <= 0 || tl.fps > 240) throw bad();
  if (!Number.isInteger(tl.duration) || tl.duration < 1 || tl.duration > maxTimelineFrames || !Number.isInteger(tl.current) || tl.current < 0 || tl.current >= tl.duration) throw bad();
  if (tl.work !== undefined && !(Array.isArray(tl.work) && tl.work.length === 2 && tl.work.every(frameInt) && tl.work[0] < tl.work[1])) throw bad();
  if (tl.hideAltered !== undefined && typeof tl.hideAltered !== 'boolean') throw bad();
  if (tl.onion !== undefined) {
    const o = tl.onion;
    if (!o || typeof o.enabled !== 'boolean' || ![o.before, o.after].every((n) => Number.isInteger(n) && n >= 0 && n <= 8) || !finite(o.opacity) || o.opacity < 0 || o.opacity > 1 || (o.blend !== undefined && !onionBlends.includes(o.blend))) throw bad();
  }
  if (!tl.clips || typeof tl.clips !== 'object' || Array.isArray(tl.clips)) throw bad();
  for (const c of Object.values(tl.clips)) {
    if (!c || !frameInt(c.start) || !frameInt(c.in) || !Number.isInteger(c.length) || c.length < 1 || c.length > maxTimelineFrames * 4) throw bad();
    if (!validateKeys(c.keys) || !validTransition(c.fadeIn, 'in') || !validTransition(c.fadeOut, 'out')) throw bad();
    if (c.offset !== undefined && !(Array.isArray(c.offset) && c.offset.length === 2 && c.offset.every(finite))) throw bad();
  }
  validateAudio(tl.audio);
  delete tl.placed;
}
