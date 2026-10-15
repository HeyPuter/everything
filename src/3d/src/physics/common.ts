// Shared physics helpers: deterministic random numbers, transforms at arbitrary
// frames, frame caches with invalidation hashes and a per-evaluation time budget.
import { Matrix4 } from 'three';
import type { DocumentData, ObjectData } from '../data/types';
import type { Depsgraph } from '../eval/depsgraph';
import { localMatrix, toMatrix4 } from '../eval/transform';
import { evaluateFCurve } from '../anim/fcurve';

// ---------------------------------------------------------------------------
// Deterministic hashing / random numbers

/** 32-bit integer hash of up to four integers (avalanching mixer). */
export function hash32(a: number, b = 0, c = 0, d = 0): number {
  let h = 0x811c9dc5 ^ Math.imul(a | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h ^= Math.imul(b | 0, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f);
  h ^= Math.imul(c | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h ^= Math.imul(d | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Uniform random in [0, 1) from integer keys. */
export function rand01(a: number, b = 0, c = 0, d = 0): number {
  return hash32(a, b, c, d) / 4294967296;
}

/** Stable string hash (for settings signatures). */
export function strHash(s: string): string {
  let h1 = 0x811c9dc5,
    h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + s.length.toString(36);
}

/** Cheap checksum of a numeric array (topology identity independent of array identity). */
export function arrayChecksum(a: ArrayLike<number>): number {
  let h = a.length | 0;
  for (let i = 0; i < a.length; i++) h = (Math.imul(h, 31) + Math.round(a[i] * 1000)) | 0;
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Transforms at arbitrary frames

const TRANSFORM_PATHS = new Set(['location', 'rotation_euler', 'rotation_quaternion', 'rotation_axis_angle', 'scale', 'delta_location', 'delta_rotation_euler', 'delta_scale']);

function transformFCurves(doc: DocumentData, ob: ObjectData) {
  const act = ob.animation_data?.action ? doc.actions[ob.animation_data.action] : undefined;
  return act ? act.fcurves.filter((fc) => !fc.mute && fc.keyframe_points.length && TRANSFORM_PATHS.has(fc.data_path)) : [];
}

/**
 * World matrix of an object at any frame, from its action's transform channels and
 * its parent chain. Constraints, drivers and NLA are not evaluated (the depsgraph's
 * result is used instead for the current frame where available).
 */
export function objectWorldAt(doc: DocumentData, ob: ObjectData, frame: number, depth = 0): Matrix4 {
  const fcs = transformFCurves(doc, ob);
  let src: ObjectData = ob;
  if (fcs.length) {
    src = {
      ...ob,
      location: [...ob.location],
      rotation_euler: [...ob.rotation_euler],
      rotation_quaternion: [...ob.rotation_quaternion],
      rotation_axis_angle: [...ob.rotation_axis_angle],
      scale: [...ob.scale],
      delta_location: [...ob.delta_location],
      delta_rotation_euler: [...ob.delta_rotation_euler],
      delta_scale: [...ob.delta_scale],
    };
    for (const fc of fcs) {
      const arr = (src as unknown as Record<string, number[]>)[fc.data_path];
      if (arr && fc.array_index < arr.length) arr[fc.array_index] = evaluateFCurve(fc, frame);
    }
  }
  const m = localMatrix(src, new Matrix4());
  const parent = ob.parent ? doc.objects[ob.parent] : undefined;
  if (parent && depth < 32) m.premultiply(objectWorldAt(doc, parent, frame, depth + 1).multiply(toMatrix4(ob.matrix_parent_inverse)));
  return m;
}

/** Whether the object's transform (or a parent's) is animated. */
export function isTransformAnimated(doc: DocumentData, ob: ObjectData, depth = 0): boolean {
  if (transformFCurves(doc, ob).length) return true;
  const parent = ob.parent ? doc.objects[ob.parent] : undefined;
  return !!parent && depth < 32 && isTransformAnimated(doc, parent, depth + 1);
}

/**
 * Key describing how an object moves over time: its world matrix at the reference
 * frame plus its animation curves. Changes to it invalidate simulations that use it.
 */
export function motionKey(doc: DocumentData, ob: ObjectData, refFrame: number): string {
  const m = objectWorldAt(doc, ob, refFrame);
  let s = m.elements.map((x) => x.toFixed(5)).join(',');
  let cur: ObjectData | undefined = ob;
  for (let d = 0; cur && d < 32; d++) {
    for (const fc of transformFCurves(doc, cur)) s += `|${cur.id}:${fc.data_path}${fc.array_index}:${fc.extrapolation}:${fc.keyframe_points.map((k) => `${k.co[0]},${k.co[1]},${k.interpolation},${k.handle_left},${k.handle_right}`).join(';')}`;
    cur = cur.parent ? doc.objects[cur.parent] : undefined;
  }
  return s;
}

/** Simulation context passed to solvers stepping frames. */
export interface SimContext {
  doc: DocumentData;
  graph: Depsgraph | null;
}

/** World matrix at a frame: the depsgraph's evaluated matrix for the current frame, else from animation. */
export function worldAt(ctx: SimContext, ob: ObjectData, frame: number): Matrix4 {
  if (ctx.graph && Math.round(ctx.graph.frame) === frame) {
    const ev = ctx.graph.get(ob.id);
    if (ev && ev.ob === ob) return ev.world.clone();
  }
  return objectWorldAt(ctx.doc, ob, frame);
}

// ---------------------------------------------------------------------------
// Time budget: interactive evaluations simulate at most ~budget ms, then show the
// latest computed frame and request another evaluation to continue.

export const simBudget = {
  deadline: Infinity,
  exceeded: false,
};

export function startBudget(ms: number) {
  simBudget.deadline = Number.isFinite(ms) ? performance.now() + ms : Infinity;
  simBudget.exceeded = false;
}

/** True when stepping must stop for this evaluation (marks the budget exceeded). */
export function outOfTime(): boolean {
  if (simBudget.deadline === Infinity) return false;
  if (performance.now() > simBudget.deadline) {
    simBudget.exceeded = true;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Frame caches

export interface CacheInfo {
  key: string;
  label: string;
  frames: number;
  last: number;
  start: number;
  end: number;
  baked: boolean;
  outdated: boolean;
}

/** Generic per-frame cache. `frames` holds output states; `live` the resumable solver state. */
export class FrameCache<T, L = unknown> {
  hash = '';
  frames = new Map<number, T>();
  /** last frame stepped (live state corresponds to this frame) */
  last = -Infinity;
  live: L | null = null;
  start = 1;
  end = 250;
  baked = false;
  label = '';
  touched = 0;

  reset(hash: string) {
    this.hash = hash;
    this.frames.clear();
    this.last = -Infinity;
    this.live = null;
  }

  /** Nearest cached frame at or before `f` (for display while catching up). */
  nearest(f: number): T | undefined {
    if (this.frames.has(f)) return this.frames.get(f);
    let best = -Infinity;
    for (const k of this.frames.keys()) if (k <= f && k > best) best = k;
    return best > -Infinity ? this.frames.get(best) : undefined;
  }
}

export const caches = new Map<string, FrameCache<unknown, unknown>>();
let touchClock = 0;

export function getCache<T, L>(key: string): FrameCache<T, L> {
  let c = caches.get(key) as FrameCache<T, L> | undefined;
  if (!c) {
    c = new FrameCache<T, L>();
    caches.set(key, c as FrameCache<unknown, unknown>);
  }
  c.touched = ++touchClock;
  return c;
}

export function cacheInfo(key: string): CacheInfo | null {
  const c = caches.get(key);
  if (!c) return null;
  return { key, label: c.label, frames: c.frames.size, last: c.last, start: c.start, end: c.end, baked: c.baked, outdated: c.frames.size === 0 };
}

export function freeCache(key: string) {
  const c = caches.get(key);
  if (c) c.reset('');
}

/** Clamp to integer frame. */
export const frameOf = (graph: { frame: number }) => Math.floor(graph.frame + 1e-6);

/** Objects in a collection and its child collections (null when no collection is given). */
export function collectionMembers(doc: DocumentData, cid: string | null | undefined): Set<string> | null {
  const c = cid ? doc.collections[cid] : undefined;
  if (!c) return null;
  const out = new Set<string>();
  const visit = (id: string, depth: number) => {
    const cc = doc.collections[id];
    if (!cc || depth > 32) return;
    for (const o of cc.objects) out.add(o);
    for (const ch of cc.children) visit(ch, depth + 1);
  };
  visit(c.id, 0);
  return out;
}
