// Shared physics helpers: deterministic random numbers, transforms at arbitrary
// frames, frame caches with invalidation hashes and a per-evaluation time budget.
import { Matrix4 } from 'three';
import type { DocumentData, ObjectData } from '../data/types';
import type { Depsgraph } from '../eval/depsgraph';
import { localMatrix, toMatrix4 } from '../eval/transform';
import { evaluateFCurve } from '../anim/fcurve';
import { objectCurves } from '../anim/slots';
import { physicsState } from './runtime';

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
  return objectCurves(doc, ob).filter((fc) => !fc.mute && fc.keyframe_points.length && TRANSFORM_PATHS.has(fc.data_path));
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

// ---------------------------------------------------------------------------
// Memory budget of the in-memory frame caches

const MB = 1 << 20;

/** A fixed share of the device's memory (when the browser tells it), at most 1 GB. */
function defaultBudget(): number {
  const dm = typeof navigator !== 'undefined' ? (navigator as { deviceMemory?: number }).deviceMemory : undefined;
  return dm ? Math.max(256 * MB, Math.min(1024 * MB, (dm * 1024 * MB) / 4)) : 1024 * MB;
}

export const cacheMemory = {
  /** bytes the cached frames of all simulations may take together */
  budget: defaultBudget(),
  /** the frame being evaluated: cached frames far from it are dropped first */
  frame: 1,
  /** baked frames alone are over the budget (they are never dropped) */
  onOverflow: null as ((bytes: number) => void) | null,
};

/** Approximate memory of a cached frame (typed arrays and numbers, a few levels deep). */
export function frameBytes(v: unknown, depth = 0): number {
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (typeof v === 'number') return 8;
  if (!v || typeof v !== 'object' || depth > 3) return 0;
  let n = 0;
  for (const x of Array.isArray(v) ? v : Object.values(v)) n += frameBytes(x, depth + 1);
  return n;
}

/** Frames of a cache, keeping count of their memory; adding frames keeps all caches within the budget. */
export class FrameMap<T> extends Map<number, T> {
  bytes = 0;
  private sizes = new Map<number, number>();
  owner: FrameCache<T, unknown> | null = null;

  set(k: number, v: T) {
    // Map's constructor may call set before the fields exist
    if (!this.sizes) return super.set(k, v);
    const b = frameBytes(v);
    this.bytes += b - (this.sizes.get(k) ?? 0);
    this.sizes.set(k, b);
    super.set(k, v);
    if (this.owner) enforceBudget(this.owner as FrameCache<unknown, unknown>);
    return this;
  }

  delete(k: number) {
    this.bytes -= this.sizes.get(k) ?? 0;
    this.sizes.delete(k);
    return super.delete(k);
  }

  clear() {
    this.bytes = 0;
    this.sizes?.clear();
    if (this.owner) this.owner.evicted = false;
    super.clear();
  }
}

/** Memory of the cached frames of every simulation. */
export function cachedBytes(): number {
  let n = 0;
  for (const c of caches.values()) n += c.frames instanceof FrameMap ? c.frames.bytes : 0;
  return n;
}

/** Whether the cached frames are over the memory budget (bakes stop when they are). */
export const budgetExceeded = () => cachedBytes() > cacheMemory.budget;

/**
 * Drop cached frames farthest from the current frame until the caches fit in the budget again.
 * Baked caches, the frames a solver steps from and the frames around the current one are kept;
 * nothing is dropped while a bake runs (the bake checks the budget itself).
 */
function enforceBudget(adding: FrameCache<unknown, unknown>) {
  let total = cachedBytes();
  if (total <= cacheMemory.budget || physicsState.baking) return;
  const cur = cacheMemory.frame;
  const drop: { c: FrameCache<unknown, unknown>; k: number; d: number }[] = [];
  for (const c of caches.values()) {
    if (c.baked || !(c.frames instanceof FrameMap)) continue;
    // the frame being added is one past `last` (the solver's state)
    const top = c === adding ? c.last + 1 : c.last;
    for (const k of c.frames.keys()) {
      if (k >= c.last - 2 && k <= top) continue;
      if (k === c.start || Math.abs(k - cur) <= 2) continue;
      drop.push({ c, k, d: Math.abs(k - cur) });
    }
  }
  drop.sort((a, b) => b.d - a.d);
  // a little below the budget, so that sorting does not happen for every new frame
  const target = cacheMemory.budget * 0.9;
  for (const { c, k } of drop) {
    if (total <= target) break;
    const before = c.frames.bytes;
    c.frames.delete(k);
    c.evicted = true;
    total -= before - c.frames.bytes;
  }
  if (total > cacheMemory.budget) cacheMemory.onOverflow?.(total);
}

/** Generic per-frame cache. `frames` holds output states; `live` the resumable solver state. */
export class FrameCache<T, L = unknown> {
  hash = '';
  private _frames = this.adopt(new FrameMap<T>());
  /** last frame stepped (live state corresponds to this frame) */
  last = -Infinity;
  live: L | null = null;
  start = 1;
  end = 250;
  baked = false;
  label = '';
  touched = 0;
  /** frames were dropped to save memory (frames before `last` may be missing) */
  evicted = false;

  get frames(): FrameMap<T> {
    return this._frames;
  }
  set frames(m: Map<number, T>) {
    if (m instanceof FrameMap) this._frames = this.adopt(m);
    else {
      const fm = this.adopt(new FrameMap<T>());
      fm.owner = null;
      for (const [k, v] of m) fm.set(k, v);
      fm.owner = this as FrameCache<T, unknown>;
      this._frames = fm;
    }
  }

  private adopt(m: FrameMap<T>) {
    m.owner = this as FrameCache<T, unknown>;
    return m;
  }

  reset(hash: string) {
    this.hash = hash;
    this.frames.clear();
    this.last = -Infinity;
    this.live = null;
    this.evicted = false;
  }

  /**
   * Before evaluating frame `f`: when it was dropped to save memory, start the solver over (the
   * frames are simulated again from the start; other cached frames stay until they are replaced).
   */
  rewindFor(f: number) {
    if (this.evicted && !this.baked && f < this.last && !this.frames.has(f)) {
      this.live = null;
      this.last = -Infinity;
    }
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

/**
 * A step or iteration count from the settings, rounded and kept within the limits of its field:
 * files and scripts can set anything, and a count of 1e9 would hang the evaluation.
 */
export function stepCount(v: unknown, lo: number, hi: number, fallback = lo): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
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
