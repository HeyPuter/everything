// Frame animation. A document with `animation` keeps one shared set of layers
// and a list of frames; each frame records the per-layer properties that may
// differ between frames (visibility, position offset, opacity, fill opacity,
// blend mode and layer style). Pixel, text and shape edits change the shared
// layers and so apply to every frame.
//
// The document's layers always show the current frame: `applyFrame` writes a
// frame's record into the layers when another frame is selected, and
// `syncAnimation` (run on every new history state) records edits made while a
// frame is shown back into that frame. Position offsets are relative: moving a
// layer in one frame adds to that frame's offset, and switching frames
// translates each layer by the difference between the two offsets.
import { isDocumentId } from './ids';
import { allLayers, blends, type Blend, type Layer, type PhotoDocument } from './document';
import { commitPixelTranslation, pixelTransformKind } from './pixel-layer';

export type FrameLayerState = {
  visible: boolean;
  // Offset in document pixels added to the layer's shared position.
  dx: number;
  dy: number;
  opacity: number;
  // Absent means 1 (as on layers).
  fillOpacity?: number;
  blend: Blend;
  // The layer style shown in this frame; absent means none.
  style?: Record<string, unknown>;
};
export type AnimationFrame = {
  id: string;
  // Display time in milliseconds.
  delay: number;
  layers: Record<string, FrameLayerState>;
};
// How onion skins combine with the frame shown; absent means multiply.
export const onionBlends = ['multiply', 'normal', 'darken', 'lighten', 'difference'] as const;
export type OnionSkin = { enabled: boolean; before: number; after: number; opacity: number; blend?: (typeof onionBlends)[number] };
// When a property is unified, changing it in one frame changes it in all.
export type AnimationUnify = { position?: boolean; visibility?: boolean; style?: boolean };
export type FrameAnimation = {
  frames: AnimationFrame[];
  // Index of the frame the layers currently show.
  current: number;
  // Number of times the animation plays; 0 repeats forever.
  loop: number;
  onion?: OnionSkin;
  unify?: AnimationUnify;
};

export const maxFrames = 2000;
export const maxDelay = 600_000;
export const defaultDelay = 100;
export const defaultOnion: OnionSkin = { enabled: false, before: 1, after: 1, opacity: 0.35 };

/** Layers whose position can differ per frame (groups move with their children). */
export const positionable = (l: Layer) => l.kind !== 'group' && l.kind !== 'adjustment';

const cloneStyle = (s: Record<string, unknown> | undefined) => (s ? (JSON.parse(JSON.stringify(s)) as Record<string, unknown>) : undefined);

// Canonical key order keeps identical states JSON-identical, so recording a
// frame that did not change never creates a history entry.
export function frameState(s: FrameLayerState): FrameLayerState {
  const out: FrameLayerState = { visible: s.visible, dx: s.dx, dy: s.dy, opacity: s.opacity, blend: s.blend };
  if (s.fillOpacity !== undefined && s.fillOpacity !== 1) out.fillOpacity = s.fillOpacity;
  if (s.style) out.style = cloneStyle(s.style);
  return out;
}
/** The frame-dependent properties of a layer as currently shown. */
export function captureState(l: Layer, dx = 0, dy = 0): FrameLayerState {
  return frameState({ visible: l.visible, dx, dy, opacity: l.opacity, fillOpacity: l.fillOpacity, blend: l.blend, style: l.style });
}
export function newFrameId() {
  return crypto.randomUUID();
}

/** A one-frame animation that records the document as it is. */
export function createAnimation(doc: PhotoDocument, delay = defaultDelay): FrameAnimation {
  const layers: Record<string, FrameLayerState> = {};
  for (const l of allLayers(doc.layers)) layers[l.id] = captureState(l);
  return { frames: [{ id: newFrameId(), delay, layers }], current: 0, loop: 0 };
}

/** How far a layer moved between two states, or null when it did not only
 * move (where its content sits: the tile origin of pixel layers, else the
 * transform's corner). */
export function moveDelta(before: Layer, after: Layer): [number, number] | null {
  if (!positionable(after) || before.kind !== after.kind) return null;
  if (after.kind === 'pixel') {
    const a = before.pixels,
      b = after.pixels;
    // Only an unchanged tile set at a new origin is a move; repainting or
    // resampling rebuilds tiles and applies to every frame.
    if (!a || !b || (a.x === b.x && a.y === b.y)) return null;
    if (JSON.stringify(a.tiles) !== JSON.stringify(b.tiles) || JSON.stringify(a.bounds) !== JSON.stringify(b.bounds)) return null;
    return [b.x - a.x, b.y - a.y];
  }
  const s = before.transform,
    t = after.transform;
  if (s.width !== t.width || s.height !== t.height || s.rotation !== t.rotation) return null;
  // A new frame (flip, skew, warp) of an embedded object is a new placement,
  // not a move, even where its bounds keep their size.
  if (JSON.stringify(before.embed?.frame?.quad) !== JSON.stringify(after.embed?.frame?.quad)) return null;
  if (s.x === t.x && s.y === t.y) return null;
  return [t.x - s.x, t.y - s.y];
}

/** Record the current frame from the document's layers after an edit.
 * `before` is the previous history state: a layer that only moved there adds
 * the move to this frame's offset. Every frame gets a record for every layer
 * (new layers appear in all frames) and records of deleted layers are dropped. */
export function syncAnimation(after: PhotoDocument, before?: PhotoDocument) {
  const anim = after.animation;
  if (!anim) return;
  if (!anim.frames.length) {
    delete after.animation;
    return;
  }
  anim.current = Math.max(0, Math.min(anim.frames.length - 1, Math.round(anim.current) || 0));
  const frame = anim.frames[anim.current];
  const prev = before?.animation;
  // Moves are per frame only while the same frame stays shown on the same
  // canvas; frame switches, crops and canvas resizes move every frame alike,
  // and an edit that rewrote the frame's records (revert, restoring a
  // snapshot or version) sets the positions it brings.
  const tracking =
    !!prev && !!before && prev.frames[prev.current]?.id === frame.id && before.width === after.width && before.height === after.height &&
    JSON.stringify(prev.frames[prev.current].layers) === JSON.stringify(frame.layers);
  const old = tracking ? new Map(allLayers(before!.layers).map((l) => [l.id, l])) : undefined;
  const live = allLayers(after.layers);
  const ids = new Set(live.map((l) => l.id));
  for (const f of anim.frames) for (const id of Object.keys(f.layers)) if (!ids.has(id)) delete f.layers[id];
  const unify = anim.unify ?? {};
  for (const l of live) {
    const was = frame.layers[l.id];
    const moved = old?.has(l.id) ? moveDelta(old.get(l.id)!, l) : null;
    const state = captureState(l, (was?.dx ?? 0) + (moved?.[0] ?? 0), (was?.dy ?? 0) + (moved?.[1] ?? 0));
    for (const f of anim.frames) {
      if (f === frame) continue;
      const other = f.layers[l.id];
      if (!other) {
        f.layers[l.id] = frameState(state);
        continue;
      }
      if (!was) continue;
      if (unify.position && moved) {
        other.dx += moved[0];
        other.dy += moved[1];
      }
      if (unify.visibility && was.visible !== state.visible) other.visible = state.visible;
      if (unify.style && JSON.stringify(was.style) !== JSON.stringify(state.style)) f.layers[l.id] = frameState({ ...other, style: state.style });
    }
    frame.layers[l.id] = state;
  }
}

// Pixel layers live on the pixel grid: their offsets are applied rounded, so
// any sequence of frame switches lands every layer on the same pixels.
const offset = (l: Layer, v: number) => (l.kind === 'pixel' ? Math.round(v) : v);

/** Show frame `index`: write its records into the document's layers. */
export function applyFrame(doc: PhotoDocument, index: number) {
  const anim = doc.animation;
  if (!anim || !Number.isInteger(index) || index < 0 || index >= anim.frames.length) return;
  const from = anim.frames[anim.current] ?? anim.frames[index];
  const to = anim.frames[index];
  for (const l of allLayers(doc.layers)) {
    const was = from.layers[l.id];
    let s = to.layers[l.id];
    if (!s) {
      if (!was) continue;
      s = to.layers[l.id] = frameState(was);
    }
    l.visible = s.visible;
    l.opacity = s.opacity;
    if (s.fillOpacity === undefined) delete l.fillOpacity;
    else l.fillOpacity = s.fillOpacity;
    if (s.blend !== 'pass through' || l.kind === 'group') l.blend = s.blend;
    if (s.style) l.style = cloneStyle(s.style);
    else delete l.style;
    if (was && positionable(l)) {
      const dx = offset(l, s.dx) - offset(l, was.dx),
        dy = offset(l, s.dy) - offset(l, was.dy);
      if (dx || dy) l.transform = { ...l.transform, x: l.transform.x + dx, y: l.transform.y + dy };
    }
  }
  anim.current = index;
}

/** A copy of the document showing frame `index` (for rendering and export). */
export function frameDocument(doc: PhotoDocument, index: number): PhotoDocument {
  const anim = doc.animation;
  if (!anim || index === anim.current) return doc;
  const copy = structuredClone(doc);
  applyFrame(copy, index);
  for (const l of allLayers(copy.layers)) if (l.kind === 'pixel' && l.pixels && pixelTransformKind(l) === 'translate') commitPixelTranslation(l);
  return copy;
}

// Properties that frames change, left out of the shared-content description.
const frameFields = new Set(['visible', 'opacity', 'fillOpacity', 'blend', 'style']);
const placed = new Set(['transform', 'pixels', 'maskGrid', 'liveSource', 'liveMask']);
/** Describe the shared layer content independent of the frame shown: per-frame
 * properties are dropped and positions are given without the current frame's
 * offsets. Combined with a frame's record it identifies what that frame shows,
 * without building the frame's document. */
export function sharedContent(doc: PhotoDocument) {
  const anim = doc.animation;
  const cur = anim?.frames[anim.current];
  const content = JSON.stringify(doc.layers, function (this: unknown, key, value) {
    if (frameFields.has(key) && this && typeof this === 'object' && 'kind' in this) return undefined;
    if (placed.has(key) && value && typeof value === 'object') return { ...value, x: undefined, y: undefined };
    return value;
  });
  const bases = allLayers(doc.layers).map((l) => {
    const s = cur?.layers[l.id];
    const at = l.kind === 'pixel' && l.pixels ? [l.pixels.x, l.pixels.y, l.transform.x, l.transform.y] : [l.transform.x, l.transform.y];
    return s && positionable(l) ? at.map((v, i) => v - offset(l, i % 2 ? s.dy : s.dx)) : at;
  });
  return `${content}|${JSON.stringify(bases)}`;
}
/** What frame `index` adds to the shared content (its layer records). */
export function frameContent(doc: PhotoDocument, index: number) {
  const f = doc.animation?.frames[index];
  if (!f) return '';
  return JSON.stringify(allLayers(doc.layers).map((l) => {
    const s = f.layers[l.id];
    return s ? [s.visible, s.opacity, s.fillOpacity ?? 1, s.blend, s.style ?? null, offset(l, s.dx), offset(l, s.dy)] : null;
  }));
}

/** Insert a copy of each listed frame after the last of them; selects the first copy. */
export function duplicateFrames(doc: PhotoDocument, indices: number[]) {
  const anim = doc.animation!;
  const list = [...new Set(indices)].filter((i) => i >= 0 && i < anim.frames.length).sort((a, b) => a - b);
  if (!list.length || anim.frames.length + list.length > maxFrames) return;
  const copies = list.map((i) => copyFrame(anim.frames[i]));
  const at = list.at(-1)! + 1;
  anim.frames.splice(at, 0, ...copies);
  // The first copy shows the same state as its source, so the layers are
  // already right after re-applying it.
  const source = list[0];
  if (source !== anim.current) applyFrame(doc, source);
  anim.current = at;
}
export function copyFrame(f: AnimationFrame): AnimationFrame {
  const layers: Record<string, FrameLayerState> = {};
  for (const [id, s] of Object.entries(f.layers)) layers[id] = frameState(s);
  return { id: newFrameId(), delay: f.delay, layers };
}

/** Delete frames; at least one frame remains. Returns false when none could go. */
export function deleteFrames(doc: PhotoDocument, indices: number[]) {
  const anim = doc.animation!;
  const drop = new Set(indices.filter((i) => i >= 0 && i < anim.frames.length));
  if (!drop.size || drop.size >= anim.frames.length) return false;
  // Show the nearest surviving frame before removing the others.
  let keep = anim.current;
  if (drop.has(keep)) {
    const survivors = anim.frames.map((_, i) => i).filter((i) => !drop.has(i));
    keep = survivors.find((i) => i > keep) ?? survivors.at(-1)!;
  }
  applyFrame(doc, keep);
  const id = anim.frames[keep].id;
  anim.frames = anim.frames.filter((_, i) => !drop.has(i));
  anim.current = anim.frames.findIndex((f) => f.id === id);
  return true;
}

/** Reverse the order of the listed frames among their own positions (all
 * frames when fewer than two are listed). */
export function reverseFrames(doc: PhotoDocument, indices: number[]) {
  const anim = doc.animation!;
  let list = [...new Set(indices)].filter((i) => i >= 0 && i < anim.frames.length).sort((a, b) => a - b);
  if (list.length < 2) list = anim.frames.map((_, i) => i);
  const id = anim.frames[anim.current].id;
  const picked = list.map((i) => anim.frames[i]).reverse();
  list.forEach((i, k) => (anim.frames[i] = picked[k]));
  anim.current = anim.frames.findIndex((f) => f.id === id);
}

/** Move the listed frames so they start at `target` (an index in the list
 * without them), keeping their order. */
export function moveFrames(doc: PhotoDocument, indices: number[], target: number) {
  const anim = doc.animation!;
  const set = new Set(indices.filter((i) => i >= 0 && i < anim.frames.length));
  if (!set.size) return;
  const id = anim.frames[anim.current].id;
  const moving = anim.frames.filter((_, i) => set.has(i));
  const rest = anim.frames.filter((_, i) => !set.has(i));
  rest.splice(Math.max(0, Math.min(rest.length, target)), 0, ...moving);
  anim.frames = rest;
  anim.current = anim.frames.findIndex((f) => f.id === id);
}

export function setFrameDelay(doc: PhotoDocument, indices: number[], delay: number) {
  const anim = doc.animation!;
  const ms = Math.max(0, Math.min(maxDelay, Math.round(delay)));
  for (const i of indices) if (anim.frames[i]) anim.frames[i].delay = ms;
}

/** Replace the animation with one frame per top-level layer (bottom first),
 * each showing only its layer. Returns false with fewer than two layers. */
export function framesFromLayers(doc: PhotoDocument, delays: number[] = [], loop?: number) {
  const tops = doc.layers;
  if (tops.length < 2) return false;
  const base: Record<string, FrameLayerState> = {};
  for (const l of allLayers(doc.layers)) base[l.id] = captureState(l);
  const frames = tops.map((top, i): AnimationFrame => {
    const layers: Record<string, FrameLayerState> = {};
    for (const [id, s] of Object.entries(base)) layers[id] = frameState(s);
    for (const t of tops) layers[t.id] = frameState({ ...layers[t.id], visible: t === top });
    return { id: newFrameId(), delay: delays[i] ?? doc.animation?.frames[0]?.delay ?? defaultDelay, layers };
  });
  // Records equal the layers as shown, with the visibility of frame 1 applied below.
  const previous = doc.animation;
  doc.animation = { frames, current: 0, loop: loop ?? previous?.loop ?? 0, ...(previous?.onion ? { onion: previous.onion } : {}), ...(previous?.unify ? { unify: previous.unify } : {}) };
  for (const t of tops) t.visible = t === tops[0];
  return true;
}

/** After flattening: `added` (top-level layers in frame order) become the
 * animation, each frame showing only its own layer; everything else is hidden
 * in every frame. */
export function adoptFrameLayers(doc: PhotoDocument, added: Layer[]) {
  const anim = doc.animation!;
  const ids = new Set(added.map((l) => l.id));
  anim.frames.forEach((f, i) => {
    for (const l of allLayers(doc.layers)) {
      const own = added[i]?.id === l.id;
      const s = f.layers[l.id] ?? captureState(l);
      f.layers[l.id] = frameState({ ...s, visible: ids.has(l.id) ? own : false, ...(ids.has(l.id) ? { dx: 0, dy: 0, opacity: 1, blend: 'normal' as Blend, style: undefined, fillOpacity: undefined } : {}) });
    }
  });
  // Show the current frame's record directly (its layers were just created).
  const cur = anim.frames[anim.current];
  for (const l of allLayers(doc.layers)) l.visible = cur.layers[l.id].visible;
}

export type TweenOptions = {
  position: boolean;
  opacity: boolean;
  effects: boolean;
  // Restrict interpolation to these layers; others keep the first frame's state.
  layers?: Set<string>;
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Interpolate matching numeric values of two layer styles; anything that
 * cannot be interpolated switches halfway. */
export function tweenValue(a: unknown, b: unknown, t: number): unknown {
  if (typeof a === 'number' && typeof b === 'number') return lerp(a, b, t);
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.map((v, i) => tweenValue(v, b[i], t));
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out: Record<string, unknown> = {};
    const ra = a as Record<string, unknown>,
      rb = b as Record<string, unknown>;
    for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
      if (!(k in rb)) {
        if (t < 0.5) out[k] = ra[k];
      } else if (!(k in ra)) {
        if (t >= 0.5) out[k] = rb[k];
      } else out[k] = tweenValue(ra[k], rb[k], t);
    }
    return out;
  }
  return t < 0.5 ? a : b;
}

/** The state of a layer a fraction `t` of the way from `a` to `b`. A layer
 * visible in only one of the frames fades in or out when opacity is tweened. */
export function tweenState(a: FrameLayerState, b: FrameLayerState, t: number, opts: TweenOptions): FrameLayerState {
  const pick = <T>(x: T, y: T) => (t < 0.5 ? x : y);
  const s: FrameLayerState = { ...a };
  if (opts.position) {
    s.dx = lerp(a.dx, b.dx, t);
    s.dy = lerp(a.dy, b.dy, t);
  }
  if (opts.opacity) {
    const oa = a.visible ? a.opacity : 0,
      ob = b.visible ? b.opacity : 0;
    s.visible = a.visible || b.visible;
    s.opacity = a.visible === b.visible ? lerp(a.opacity, b.opacity, t) : lerp(oa, ob, t);
    s.fillOpacity = lerp(a.fillOpacity ?? 1, b.fillOpacity ?? 1, t);
  } else s.visible = pick(a.visible, b.visible);
  if (opts.effects) {
    s.style = (a.style && b.style ? tweenValue(a.style, b.style, t) : pick(a.style, b.style)) as FrameLayerState['style'];
    s.blend = pick(a.blend, b.blend);
  }
  return frameState(s);
}

/** Insert `count` frames between frames `from` and `from + 1`. */
export function tweenFrames(doc: PhotoDocument, from: number, count: number, opts: TweenOptions) {
  const anim = doc.animation!;
  const a = anim.frames[from],
    b = anim.frames[from + 1];
  if (!a || !b || count < 1 || anim.frames.length + count > maxFrames) return false;
  const made: AnimationFrame[] = [];
  for (let k = 1; k <= count; k++) {
    const t = k / (count + 1);
    const layers: Record<string, FrameLayerState> = {};
    for (const [id, sa] of Object.entries(a.layers)) {
      const sb = b.layers[id];
      layers[id] = sb && (!opts.layers || opts.layers.has(id)) ? tweenState(sa, sb, t, opts) : frameState(sa);
    }
    made.push({ id: newFrameId(), delay: a.delay, layers });
  }
  const id = anim.frames[anim.current].id;
  anim.frames.splice(from + 1, 0, ...made);
  anim.current = anim.frames.findIndex((f) => f.id === id);
  return true;
}

/** Copy the selected layers' state in the current frame to every frame. */
export function matchLayersAcrossFrames(doc: PhotoDocument, ids: string[]) {
  const anim = doc.animation!;
  const cur = anim.frames[anim.current];
  for (const id of ids) {
    const s = cur.layers[id];
    if (!s) continue;
    for (const f of anim.frames) if (f !== cur) f.layers[id] = frameState(s);
  }
}

// ----- Playback timing -----

export const totalDuration = (anim: FrameAnimation) => anim.frames.reduce((t, f) => t + f.delay, 0);
/** Frame shown `ms` after the start of one play. Zero-delay frames are skipped. */
export function frameAt(anim: FrameAnimation, ms: number) {
  let t = 0;
  for (let i = 0; i < anim.frames.length; i++) {
    t += anim.frames[i].delay;
    if (ms < t) return i;
  }
  return anim.frames.length - 1;
}
/** The frame shown at each of `count` samples taken `1000 / fps` ms apart. */
export function sampleFrames(anim: FrameAnimation, fps: number, plays = 1): number[] {
  const total = totalDuration(anim);
  if (!total) return anim.frames.map((_, i) => i);
  const n = Math.max(1, Math.round((total * plays * fps) / 1000));
  return Array.from({ length: n }, (_, k) => frameAt(anim, ((k * 1000) / fps) % total));
}
// Loop counts in container formats: GIF stores extra repeats (and omits the
// extension to play once); APNG and WebP store the play count, 0 = forever.
export const gifLoop = (plays: number) => (plays === 0 ? 0 : plays === 1 ? -1 : Math.min(65535, plays - 1));
export const loopLabel = (plays: number) => (plays === 0 ? 'Forever' : plays === 1 ? 'Once' : `${plays} times`);
export function delayLabel(ms: number) {
  if (ms === 0) return 'No delay';
  const s = ms / 1000;
  return `${Number.isInteger(s * 10) ? s.toFixed(1) : String(Math.round(s * 1000) / 1000)} s`;
}

// ----- Validation (projects) -----

const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
export function validateAnimation(value: unknown) {
  const bad = () => new Error('Invalid frame animation.');
  const a = value as FrameAnimation;
  if (!a || typeof a !== 'object' || !Array.isArray(a.frames) || !a.frames.length || a.frames.length > maxFrames) throw bad();
  if (!Number.isInteger(a.current) || a.current < 0 || a.current >= a.frames.length) throw bad();
  if (!Number.isInteger(a.loop) || a.loop < 0 || a.loop > 65535) throw bad();
  if (a.onion !== undefined) {
    const o = a.onion;
    if (!o || typeof o.enabled !== 'boolean' || ![o.before, o.after].every((n) => Number.isInteger(n) && n >= 0 && n <= 8) || !finite(o.opacity) || o.opacity < 0 || o.opacity > 1 || (o.blend !== undefined && !onionBlends.includes(o.blend))) throw bad();
  }
  if (a.unify !== undefined && (!a.unify || typeof a.unify !== 'object' || Object.values(a.unify).some((v) => typeof v !== 'boolean'))) throw bad();
  const ids = new Set<string>();
  for (const f of a.frames) {
    if (!f || !isDocumentId(f.id) || ids.has(f.id) || !Number.isInteger(f.delay) || f.delay < 0 || f.delay > maxDelay || !f.layers || typeof f.layers !== 'object' || Array.isArray(f.layers)) throw bad();
    ids.add(f.id);
    for (const s of Object.values(f.layers))
      if (
        !s || typeof s.visible !== 'boolean' || !finite(s.dx) || !finite(s.dy) || !finite(s.opacity) || s.opacity < 0 || s.opacity > 1 ||
        (s.fillOpacity !== undefined && (!finite(s.fillOpacity) || s.fillOpacity < 0 || s.fillOpacity > 1)) ||
        !(blends.includes(s.blend) || s.blend === 'pass through') ||
        (s.style !== undefined && (!s.style || typeof s.style !== 'object' || Array.isArray(s.style)))
      )
        throw bad();
  }
}
