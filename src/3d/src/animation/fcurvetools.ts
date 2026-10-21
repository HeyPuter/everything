// F-Curve shaping tools: blend/ease sliders, smoothing filters (moving average,
// Gaussian, Butterworth), decimation, baking, Euler discontinuity filtering and
// handle equalization. Pure document logic shared by the Graph Editor and Dope
// Sheet operators (and unit tests).
import type { FCurve, Keyframe } from '../data/types';
import type { CurveRef } from './channels';
import { evaluateFCurve, calcHandles, insertKeyframe } from '../anim/fcurve';
import { cloneKey, editable, finalizeCurve, isKeySelected, propertyDefault, setKeySelected } from './keyedit';

/** A run of consecutive selected keys on one curve (indices are inclusive). */
export interface Segment {
  fc: FCurve;
  start: number;
  end: number;
}

/** Runs of consecutive selected keys of a curve. */
export function curveSegments(fc: FCurve): Segment[] {
  const out: Segment[] = [];
  const k = fc.keyframe_points;
  let s = -1;
  for (let i = 0; i <= k.length; i++) {
    const sel = i < k.length && isKeySelected(k[i]);
    if (sel && s < 0) s = i;
    else if (!sel && s >= 0) {
      out.push({ fc, start: s, end: i - 1 });
      s = -1;
    }
  }
  return out;
}

export function selectedSegments(curves: CurveRef[]): Segment[] {
  const seen = new Set<FCurve>();
  const out: Segment[] = [];
  for (const { fc } of editable(curves)) {
    if (seen.has(fc)) continue;
    seen.add(fc);
    out.push(...curveSegments(fc));
  }
  return out;
}

/** The keys just outside a segment (the segment's own end keys when it touches the curve ends). */
export function neighbours(seg: Segment): { left: Keyframe; right: Keyframe } {
  const k = seg.fc.keyframe_points;
  return { left: k[seg.start - 1] ?? k[seg.start], right: k[seg.end + 1] ?? k[seg.end] };
}

/** Set a key's value, carrying its handles along. */
export function setKeyValue(k: Keyframe, v: number) {
  const dy = v - k.co[1];
  k.co[1] = v;
  k.handle_left[1] += dy;
  k.handle_right[1] += dy;
}

function segKeys(seg: Segment) {
  return seg.fc.keyframe_points.slice(seg.start, seg.end + 1);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Position of a frame between the segment's neighbours, 0..1. */
function along(left: Keyframe, right: Keyframe, frame: number) {
  const span = right.co[0] - left.co[0];
  return span > 1e-9 ? (frame - left.co[0]) / span : 0.5;
}

// ---------------------------------------------------------------------------
// Blend tools (all take the slider factor, usually in -1..1)

export type BlendTool =
  | 'BREAKDOWN'
  | 'BLEND_TO_NEIGHBOR'
  | 'BLEND_TO_DEFAULT'
  | 'EASE'
  | 'BLEND_OFFSET'
  | 'BLEND_TO_EASE'
  | 'MATCH_SLOPE'
  | 'PUSH_PULL'
  | 'SHEAR'
  | 'SCALE_AVERAGE'
  | 'SCALE_FROM_NEIGHBOR'
  | 'TIME_OFFSET';

export interface BlendOptions {
  /** EASE: curve steepness */
  sharpness?: number;
  /** SHEAR: which neighbour stays put */
  direction?: 'FROM_LEFT' | 'FROM_RIGHT';
  /** SCALE_FROM_NEIGHBOR: the neighbour the keys scale towards */
  anchor?: 'LEFT' | 'RIGHT';
}

/**
 * S-shaped ease from 0 to 1 (an algebraic sigmoid, normalized to the segment). `shift` (-1..1)
 * moves the steep part towards the start (positive) or the end (negative); `sharpness` is its
 * steepness. Matches the reference app's Ease tool.
 */
export function easeCurve(x: number, shift: number, sharpness: number) {
  const t = Math.max(0, Math.min(1, x));
  const w = Math.max(1e-6, 2 * sharpness),
    c = 0.5 - shift / 2;
  const g = (u: number) => {
    const z = (u - c) * w;
    return z / Math.sqrt(1 + z * z);
  };
  const lo = g(0),
    hi = g(1);
  return hi - lo > 1e-12 ? (g(t) - lo) / (hi - lo) : t;
}

/**
 * One-sided ease used by Blend to Ease: fast start (out) or slow start (in). The ease-in shape is
 * x³ / (1 + 3(1 − x)²) (fitted exactly to the reference app's results); ease-out mirrors it.
 */
export function easeOneSided(x: number, out: boolean) {
  const t = Math.max(0, Math.min(1, x));
  const easeIn = (u: number) => (u * u * u) / (1 + 3 * (1 - u) * (1 - u));
  return out ? 1 - easeIn(1 - t) : easeIn(t);
}

/**
 * Apply a blend tool to every selected segment of the curves. Values are computed from the
 * current key values, so callers restore the original keys before re-applying (slider drag).
 * Returns warnings for segments that could not be processed.
 */
export function applyBlend(curves: CurveRef[], tool: BlendTool, factor: number, o: BlendOptions = {}): string[] {
  const warnings = new Set<string>();
  const touched = new Set<FCurve>();
  for (const seg of selectedSegments(curves)) {
    const fc = seg.fc;
    const keys = segKeys(seg);
    const { left, right } = neighbours(seg);
    const L = left.co[1],
      R = right.co[1];
    const all = fc.keyframe_points;
    switch (tool) {
      case 'BREAKDOWN': {
        const t = (factor + 1) / 2;
        for (const k of keys) setKeyValue(k, lerp(L, R, t));
        break;
      }
      case 'BLEND_TO_NEIGHBOR':
        for (const k of keys) setKeyValue(k, factor >= 0 ? lerp(k.co[1], R, factor) : lerp(k.co[1], L, -factor));
        break;
      case 'BLEND_TO_DEFAULT': {
        const def = propertyDefault(fc.data_path, fc.array_index);
        for (const k of keys) setKeyValue(k, lerp(k.co[1], def, factor));
        break;
      }
      case 'EASE': {
        const sharp = o.sharpness ?? 2;
        for (const k of keys) setKeyValue(k, lerp(L, R, easeCurve(along(left, right, k.co[0]), factor, sharp)));
        break;
      }
      case 'BLEND_OFFSET': {
        const first = keys[0],
          last = keys[keys.length - 1];
        const d = factor >= 0 ? (R - last.co[1]) * factor : (L - first.co[1]) * -factor;
        for (const k of keys) setKeyValue(k, k.co[1] + d);
        break;
      }
      case 'BLEND_TO_EASE':
        for (const k of keys) {
          const target = lerp(L, R, easeOneSided(along(left, right, k.co[0]), factor >= 0));
          setKeyValue(k, lerp(k.co[1], target, Math.abs(factor)));
        }
        break;
      case 'MATCH_SLOPE': {
        // continue the slope of the two keys beyond the segment on the chosen side
        const right2 = all[seg.end + 2],
          left2 = all[seg.start - 2];
        const hasR = seg.end + 1 < all.length && !!right2,
          hasL = seg.start > 0 && !!left2;
        if (factor >= 0 && !hasR) {
          warnings.add('Need at least two keys to the right of the selection to match the slope');
          continue;
        }
        if (factor < 0 && !hasL) {
          warnings.add('Need at least two keys to the left of the selection to match the slope');
          continue;
        }
        const [a, b] = factor >= 0 ? [right, right2] : [left2, left];
        const slope = (b.co[1] - a.co[1]) / (b.co[0] - a.co[0] || 1);
        const base = factor >= 0 ? right : left;
        for (const k of keys) setKeyValue(k, lerp(k.co[1], base.co[1] + slope * (k.co[0] - base.co[0]), Math.abs(factor)));
        break;
      }
      case 'PUSH_PULL':
        for (const k of keys) {
          const line = lerp(L, R, along(left, right, k.co[0]));
          setKeyValue(k, line + (k.co[1] - line) * factor);
        }
        break;
      case 'SHEAR': {
        const fromRight = o.direction === 'FROM_RIGHT';
        for (const k of keys) {
          const x = along(left, right, k.co[0]);
          setKeyValue(k, k.co[1] + factor * (R - L) * (fromRight ? 1 - x : x));
        }
        break;
      }
      case 'SCALE_AVERAGE': {
        const avg = keys.reduce((s, k) => s + k.co[1], 0) / keys.length;
        for (const k of keys) setKeyValue(k, avg + (k.co[1] - avg) * factor);
        break;
      }
      case 'SCALE_FROM_NEIGHBOR': {
        const anchor = o.anchor === 'RIGHT' ? R : L;
        for (const k of keys) setKeyValue(k, anchor + (k.co[1] - anchor) * factor);
        break;
      }
      case 'TIME_OFFSET': {
        // re-sample the curve shifted in time (evaluated on an untouched copy)
        const copy: FCurve = { ...fc, keyframe_points: all.map(cloneKey), modifiers: [] };
        for (const k of keys) setKeyValue(k, evaluateFCurve(copy, k.co[0] + factor));
        break;
      }
    }
    touched.add(fc);
  }
  for (const fc of touched) calcHandles(fc);
  return [...warnings];
}

// ---------------------------------------------------------------------------
// Smoothing

/** Moving-average smoothing of selected runs (ends of each run stay put). */
export function smoothKeys(curves: CurveRef[]): number {
  const w = [1 / 6, 1 / 4, 1 / 6, 1 / 4, 1 / 6];
  let n = 0;
  for (const seg of selectedSegments(curves)) {
    const keys = segKeys(seg);
    if (keys.length < 3) continue;
    const ys = keys.map((k) => k.co[1]);
    const at = (i: number) => ys[Math.max(0, Math.min(ys.length - 1, i))];
    for (let i = 1; i < keys.length - 1; i++) {
      let v = 0;
      for (let j = -2; j <= 2; j++) v += w[j + 2] * at(i + j);
      setKeyValue(keys[i], v);
      n++;
    }
    calcHandles(seg.fc);
  }
  return n;
}

/** Gaussian kernel weights for offsets -width..width. */
export function gaussianKernel(sigma: number, width: number): number[] {
  const s = Math.max(1e-3, sigma * width);
  const out: number[] = [];
  let sum = 0;
  for (let i = -width; i <= width; i++) {
    const v = Math.exp(-(i * i) / (2 * s * s));
    out.push(v);
    sum += v;
  }
  return out.map((v) => v / sum);
}

/** Gaussian smoothing: each selected key moves towards the weighted average of the curve around it. */
export function gaussianSmooth(curves: CurveRef[], factor = 1, sigma = 0.33, width = 6): number {
  const kernel = gaussianKernel(sigma, width);
  let n = 0;
  for (const seg of selectedSegments(curves)) {
    const copy: FCurve = { ...seg.fc, keyframe_points: seg.fc.keyframe_points.map(cloneKey), modifiers: [] };
    const keys = segKeys(seg);
    const targets = keys.map((k) => {
      let v = 0;
      for (let i = -width; i <= width; i++) v += kernel[i + width] * evaluateFCurve(copy, k.co[0] + i);
      return v;
    });
    keys.forEach((k, i) => setKeyValue(k, lerp(k.co[1], targets[i], factor)));
    calcHandles(seg.fc);
    n += keys.length;
  }
  return n;
}

interface Biquad {
  b: [number, number, number];
  a: [number, number, number];
}

/** Low-pass Butterworth filter as cascaded second-order sections (bilinear transform). */
export function butterworthSections(order: number, cutoff: number, sampleRate: number): Biquad[] {
  const nyq = sampleRate / 2;
  const fc = Math.min(cutoff, nyq * 0.999);
  const k = Math.tan((Math.PI * fc) / sampleRate);
  const out: Biquad[] = [];
  const pairs = Math.floor(order / 2);
  for (let i = 0; i < pairs; i++) {
    const theta = (Math.PI * (2 * i + 1)) / (2 * order);
    const q = 1 / (2 * Math.sin(theta));
    const norm = 1 / (1 + k / q + k * k);
    const b0 = k * k * norm;
    out.push({ b: [b0, 2 * b0, b0], a: [1, 2 * (k * k - 1) * norm, (1 - k / q + k * k) * norm] });
  }
  if (order % 2) {
    const norm = 1 / (1 + k);
    out.push({ b: [k * norm, k * norm, 0], a: [1, (k - 1) * norm, 0] });
  }
  return out;
}

function runSections(x: number[], secs: Biquad[]): number[] {
  let y = x;
  for (const s of secs) {
    const out = new Array<number>(y.length);
    // start in steady state for the first sample (avoids a jump at the start)
    const dc = (s.b[0] + s.b[1] + s.b[2]) / (s.a[0] + s.a[1] + s.a[2]);
    let x1 = y[0],
      x2 = y[0],
      y1 = y[0] * dc,
      y2 = y[0] * dc;
    for (let i = 0; i < y.length; i++) {
      const xi = y[i];
      const yi = s.b[0] * xi + s.b[1] * x1 + s.b[2] * x2 - s.a[1] * y1 - s.a[2] * y2;
      x2 = x1;
      x1 = xi;
      y2 = y1;
      y1 = yi;
      out[i] = yi;
    }
    y = out;
  }
  return y;
}

/** Zero-phase (forward + backward) filtering with odd reflection padding at both ends. */
export function filtfilt(x: number[], secs: Biquad[], pad: number): number[] {
  const n = x.length;
  if (n < 2) return [...x];
  const p = Math.max(0, Math.min(pad, n - 1));
  const ext: number[] = [];
  for (let i = p; i >= 1; i--) ext.push(2 * x[0] - x[i]);
  ext.push(...x);
  for (let i = n - 2; i >= n - 1 - p; i--) ext.push(2 * x[n - 1] - x[i]);
  let y = runSections(ext, secs);
  y = runSections(y.reverse(), secs).reverse();
  return y.slice(p, p + n);
}

/** Butterworth low-pass smoothing of selected runs, sampled per frame. */
export function butterworthSmooth(
  curves: CurveRef[],
  o: { cutoff?: number; order?: number; samplesPerFrame?: number; blend?: number; blendInOut?: number; fps?: number } = {},
): number {
  const cutoff = o.cutoff ?? 3,
    order = Math.max(1, Math.round(o.order ?? 4)),
    spf = Math.max(1, Math.round(o.samplesPerFrame ?? 1)),
    blend = o.blend ?? 1,
    inOut = Math.max(0, o.blendInOut ?? 1),
    fps = o.fps ?? 24;
  // the filter order counts second-order sections (each section is a pair of poles)
  const secs = butterworthSections(order * 2, cutoff, fps * spf);
  let n = 0;
  for (const seg of selectedSegments(curves)) {
    const keys = segKeys(seg);
    if (keys.length < 2) continue;
    const copy: FCurve = { ...seg.fc, keyframe_points: seg.fc.keyframe_points.map(cloneKey), modifiers: [] };
    const f0 = keys[0].co[0],
      f1 = keys[keys.length - 1].co[0];
    // the curve is sampled from the key before the selection to the key after it
    const nb = neighbours(seg);
    const s0 = Math.min(f0, nb.left.co[0]),
      s1 = Math.max(f1, nb.right.co[0]);
    const count = Math.max(2, Math.round((s1 - s0) * spf) + 1);
    const samples: number[] = [];
    for (let i = 0; i < count; i++) samples.push(evaluateFCurve(copy, s0 + i / spf));
    // held ends: the samples are padded with the first / last value on both sides
    const ext = [...new Array<number>(count).fill(samples[0]), ...samples, ...new Array<number>(count).fill(samples[count - 1])];
    const filtered = filtfilt(ext, secs, 0).slice(count, 2 * count);
    const sampleAt = (f: number) => {
      const t = (f - s0) * spf;
      const i = Math.max(0, Math.min(count - 2, Math.floor(t)));
      return lerp(filtered[i], filtered[i + 1], Math.max(0, Math.min(1, t - i)));
    };
    for (const k of keys) {
      const edge = Math.min(k.co[0] - f0, f1 - k.co[0]);
      const w = inOut > 0 ? Math.min(1, edge / inOut) : 1;
      setKeyValue(k, lerp(k.co[1], sampleAt(k.co[0]), blend * w));
      n++;
    }
    calcHandles(seg.fc);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Density

/** Largest deviation between the curve with key `i` removed and the original curve. */
function removalError(fc: FCurve, i: number, ref: (f: number) => number): number {
  const k = fc.keyframe_points;
  const a = k[i - 1],
    b = k[i + 1];
  const trial: FCurve = { ...fc, keyframe_points: k.filter((_, j) => j !== i).map(cloneKey), modifiers: [] };
  calcHandles(trial);
  let err = 0;
  const span = b.co[0] - a.co[0];
  const steps = Math.max(4, Math.ceil(span * 2));
  for (let s = 1; s < steps; s++) {
    const f = a.co[0] + (span * s) / steps;
    err = Math.max(err, Math.abs(evaluateFCurve(trial, f) - ref(f)));
  }
  return err;
}

/**
 * Remove selected keys that contribute least to the curve shape. RATIO removes that fraction of
 * the selected keys; ERROR removes keys while the curve stays within the error margin.
 */
export function decimateKeys(curves: CurveRef[], mode: 'RATIO' | 'ERROR', factor = 1 / 3, margin = 0): number {
  let removed = 0;
  const seen = new Set<FCurve>();
  for (const { fc } of editable(curves)) {
    if (seen.has(fc)) continue;
    seen.add(fc);
    const selCount = fc.keyframe_points.filter(isKeySelected).length;
    if (selCount < 3) continue;
    const orig: FCurve = { ...fc, keyframe_points: fc.keyframe_points.map(cloneKey), modifiers: [] };
    const ref = (f: number) => evaluateFCurve(orig, f);
    let budget = mode === 'RATIO' ? Math.floor(selCount * Math.max(0, Math.min(1, factor)) + 1e-6) : Infinity;
    while (budget > 0) {
      const k = fc.keyframe_points;
      let best = -1,
        bestErr = Infinity;
      for (let i = 1; i < k.length - 1; i++) {
        if (!isKeySelected(k[i])) continue;
        // keep the outer keys of each selected run so the shape around it stays anchored
        if (!isKeySelected(k[i - 1]) && !isKeySelected(k[i + 1])) continue;
        const e = removalError(fc, i, ref);
        if (e < bestErr) {
          bestErr = e;
          best = i;
        }
      }
      if (best < 0) break;
      if (mode === 'ERROR' && bestErr > margin + 1e-9) break;
      fc.keyframe_points = k.filter((_, j) => j !== best);
      calcHandles(fc);
      removed++;
      budget--;
    }
  }
  return removed;
}

/** Add a key on every whole frame between the first and last selected key of each curve. */
export function bakeKeys(curves: CurveRef[]): number {
  let added = 0;
  const seen = new Set<FCurve>();
  for (const { fc } of editable(curves)) {
    if (seen.has(fc)) continue;
    seen.add(fc);
    const sel = fc.keyframe_points.filter(isKeySelected);
    if (sel.length < 2) continue;
    const a = Math.min(...sel.map((k) => k.co[0])),
      b = Math.max(...sel.map((k) => k.co[0]));
    const copy: FCurve = { ...fc, keyframe_points: fc.keyframe_points.map(cloneKey) };
    const type = sel[0].type;
    for (let f = Math.ceil(a - 1e-6); f <= b + 1e-6; f++) {
      if (fc.keyframe_points.some((k) => Math.abs(k.co[0] - f) < 1e-4)) continue;
      insertKeyframe(fc, f, evaluateFCurve(copy, f), { type });
      added++;
    }
    for (const k of fc.keyframe_points) if (k.co[0] >= a - 1e-6 && k.co[0] <= b + 1e-6) setKeySelected(k, true);
    finalizeCurve(fc, false);
  }
  return added;
}

// ---------------------------------------------------------------------------
// Euler filter

const isEulerPath = (p: string) => /(^|\.)(rotation_euler|delta_rotation_euler)$/.test(p);

/** Remove ±2π jumps between consecutive keys of Euler rotation curves. Returns the curves changed. */
export function eulerFilter(curves: CurveRef[]): number {
  let changed = 0;
  const seen = new Set<FCurve>();
  for (const { fc } of editable(curves)) {
    if (seen.has(fc) || !isEulerPath(fc.data_path)) continue;
    seen.add(fc);
    const k = fc.keyframe_points;
    let any = false;
    for (let i = 1; i < k.length; i++) {
      const d = k[i].co[1] - k[i - 1].co[1];
      if (Math.abs(d) <= Math.PI) continue;
      const turns = Math.round(d / (2 * Math.PI));
      if (!turns) continue;
      const off = -turns * 2 * Math.PI;
      for (let j = i; j < k.length; j++) setKeyValue(k[j], k[j].co[1] + off);
      any = true;
    }
    if (any) {
      calcHandles(fc);
      changed++;
    }
  }
  return changed;
}

/** Curves eligible for the Euler filter. */
export const eulerCurves = (curves: CurveRef[]) => curves.filter((r) => isEulerPath(r.fc.data_path));

// ---------------------------------------------------------------------------
// Handles

/** Give the selected keys' handles the same length (and optionally make them flat). */
export function equalizeHandles(curves: CurveRef[], side: 'LEFT' | 'RIGHT' | 'BOTH', length = 5, flatten = false): number {
  let n = 0;
  for (const { fc } of editable(curves)) {
    let any = false;
    for (const k of fc.keyframe_points) {
      if (!isKeySelected(k)) continue;
      for (const s of ['LEFT', 'RIGHT'] as const) {
        if (side !== 'BOTH' && side !== s) continue;
        const h = s === 'LEFT' ? k.handle_left : k.handle_right;
        const sign = s === 'LEFT' ? -1 : 1;
        let dx = h[0] - k.co[0],
          dy = h[1] - k.co[1];
        if (flatten || Math.hypot(dx, dy) < 1e-9) {
          dx = sign;
          dy = 0;
        }
        const l = Math.hypot(dx, dy);
        h[0] = k.co[0] + (dx / l) * length;
        h[1] = k.co[1] + (dy / l) * length;
      }
      // the edited handles keep their new shape; the opposite side stays collinear
      k.handle_left_type = k.handle_left_type === 'FREE' ? 'FREE' : 'ALIGNED';
      k.handle_right_type = k.handle_right_type === 'FREE' ? 'FREE' : 'ALIGNED';
      if (side === 'LEFT' && flatten) k.handle_right[1] = k.co[1];
      if (side === 'RIGHT' && flatten) k.handle_left[1] = k.co[1];
      any = true;
      n++;
    }
    if (any) calcHandles(fc);
  }
  return n;
}

/** Select/deselect key points and their handles on keys that have anything selected. */
export function selectKeyHandles(curves: CurveRef[], left: 'SELECT' | 'DESELECT' | 'KEEP', right: 'SELECT' | 'DESELECT' | 'KEEP', key: 'SELECT' | 'DESELECT' | 'KEEP'): number {
  let n = 0;
  for (const { fc } of curves)
    for (const k of fc.keyframe_points) {
      if (!(k.select_control_point || k.select_left_handle || k.select_right_handle)) continue;
      if (left !== 'KEEP') k.select_left_handle = left === 'SELECT';
      if (right !== 'KEEP') k.select_right_handle = right === 'SELECT';
      if (key !== 'KEEP') k.select_control_point = key === 'SELECT';
      n++;
    }
  return n;
}

// ---------------------------------------------------------------------------
// Samples

/** Replace a curve's keys with samples on every whole frame of the keyed range. */
export function keysToSamples(fc: FCurve): boolean {
  const k = fc.keyframe_points;
  if (!k.length) return false;
  const a = Math.floor(k[0].co[0]),
    b = Math.ceil(k[k.length - 1].co[0]);
  const copy: FCurve = { ...fc, keyframe_points: k.map(cloneKey), modifiers: [] };
  const out: [number, number][] = [];
  for (let f = a; f <= b; f++) out.push([f, evaluateFCurve(copy, f)]);
  fc.sampled_points = out;
  fc.keyframe_points = [];
  return true;
}

/** Turn baked samples back into keyframes (one per sample). */
export function samplesToKeys(fc: FCurve): boolean {
  const sp = fc.sampled_points;
  if (!sp?.length) return false;
  fc.keyframe_points = [];
  for (const [f, v] of sp) {
    const key = insertKeyframe(fc, f, v);
    setKeySelected(key, false);
  }
  delete fc.sampled_points;
  finalizeCurve(fc, false);
  return true;
}

// ---------------------------------------------------------------------------
// Sound to samples

export interface EnvelopeOptions {
  /** band limits in Hz (0 / Nyquist to disable) */
  low: number;
  high: number;
  /** seconds for the envelope to rise / fall */
  attack: number;
  release: number;
  /** levels below this are zero */
  threshold: number;
  /** sum only rising changes */
  accumulate: boolean;
  /** running sum of the envelope */
  additive: boolean;
  /** on/off output above `squareThreshold` */
  square: boolean;
  squareThreshold: number;
}

/** Second-order low/high-pass section (bilinear transform of the analog prototype). */
function biquad(kind: 'low' | 'high', cutoff: number, rate: number) {
  const w = (2 * Math.PI * Math.min(cutoff, rate * 0.49)) / rate;
  const cw = Math.cos(w),
    alpha = Math.sin(w) / Math.SQRT2;
  const a0 = 1 + alpha;
  const b = kind === 'low' ? [(1 - cw) / 2, 1 - cw, (1 - cw) / 2] : [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2];
  return { b0: b[0] / a0, b1: b[1] / a0, b2: b[2] / a0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0 };
}

function runBiquad(x: Float32Array, f: ReturnType<typeof biquad>) {
  const y = new Float32Array(x.length);
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = f.b0 * x[i] + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

/** Per-frame loudness envelope of mono audio. */
export function soundEnvelope(samples: Float32Array, rate: number, fps: number, o: EnvelopeOptions): number[] {
  let x = samples;
  if (o.low > 0) x = runBiquad(x, biquad('high', o.low, rate));
  if (o.high > 0 && o.high < rate / 2) x = runBiquad(x, biquad('low', o.high, rate));
  const ka = 1 - Math.exp(-1 / Math.max(1, o.attack * rate)),
    kr = 1 - Math.exp(-1 / Math.max(1, o.release * rate));
  const perFrame = rate / fps;
  const frames = Math.ceil(x.length / perFrame);
  const out: number[] = new Array(frames).fill(0);
  let env = 0;
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i]);
    env += (v - env) * (v > env ? ka : kr);
    const fi = Math.floor(i / perFrame);
    if (env > out[fi]) out[fi] = env;
  }
  let acc = 0,
    prev = 0;
  return out.map((v0) => {
    let v = v0 < o.threshold ? 0 : v0;
    if (o.square) v = v > o.squareThreshold ? 1 : 0;
    if (o.accumulate) {
      if (v > prev) acc += v - prev;
      prev = v;
      return acc;
    }
    if (o.additive) {
      acc += v;
      return acc;
    }
    return v;
  });
}
