// Mask geometry (pure, unit tested): handle calculation, bezier sampling, feather outlines,
// shape keys, primitives and point insertion. Points live in frame space (0..1, y up);
// `aspect` (frame width / height) makes angles and distances correct on screen.
import type { MaskLayer, MaskPoint, MaskSpline, MaskShapeKey } from './types';
import { newPoint } from './types';

type V = [number, number];

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1]];
const mul = (a: V, k: number): V => [a[0] * k, a[1] * k];
const len = (a: V) => Math.hypot(a[0], a[1]);
const lerp = (a: V, b: V, t: number): V => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Neighbours of point i (null at the ends of open splines). */
function neighbours(sp: MaskSpline, i: number): [MaskPoint | null, MaskPoint | null] {
  const n = sp.points.length;
  const prev = i > 0 ? sp.points[i - 1] : sp.use_cyclic && n > 2 ? sp.points[n - 1] : null;
  const next = i < n - 1 ? sp.points[i + 1] : sp.use_cyclic && n > 2 ? sp.points[0] : null;
  return [prev, next];
}

/** Recompute AUTO and VECTOR handles (aspect-correct). */
export function recalcHandles(sp: MaskSpline, aspect = 1) {
  const toA = (p: V): V => [p[0] * aspect, p[1]];
  const fromA = (p: V): V => [p[0] / aspect, p[1]];
  sp.points.forEach((p, i) => {
    if (p.handle_type !== 'AUTO' && p.handle_type !== 'VECTOR') return;
    const [prev, next] = neighbours(sp, i);
    const c = toA(p.co);
    if (p.handle_type === 'VECTOR') {
      p.handle_left = prev ? fromA(lerp(c, toA(prev.co), 1 / 3)) : [...p.co];
      p.handle_right = next ? fromA(lerp(c, toA(next.co), 1 / 3)) : [...p.co];
      return;
    }
    const a = prev ? toA(prev.co) : null,
      b = next ? toA(next.co) : null;
    if (!a && !b) {
      p.handle_left = [...p.co];
      p.handle_right = [...p.co];
      return;
    }
    // tangent along the neighbours; handle lengths a third of each neighbour's distance
    const dir = a && b ? sub(b, a) : b ? sub(b, c) : sub(c, a!);
    const L = len(dir) || 1;
    const t = mul(dir, 1 / L);
    const dl = a ? len(sub(c, a)) / 3 : (b ? len(sub(b, c)) : 0) / 3;
    const dr = b ? len(sub(b, c)) / 3 : (a ? len(sub(c, a)) : 0) / 3;
    p.handle_left = fromA(sub(c, mul(t, dl)));
    p.handle_right = fromA(add(c, mul(t, dr)));
  });
}

/** Keep the other handle of an ALIGNED point opposite to the moved one (its length is kept). */
export function alignHandles(p: MaskPoint, moved: 'LEFT' | 'RIGHT', aspect = 1) {
  if (p.handle_type !== 'ALIGNED') return;
  const toA = (v: V): V => [v[0] * aspect, v[1]];
  const c = toA(p.co);
  const m = toA(moved === 'LEFT' ? p.handle_left : p.handle_right);
  const o = toA(moved === 'LEFT' ? p.handle_right : p.handle_left);
  const d = sub(c, m);
  const L = len(d);
  if (L < 1e-9) return;
  const ol = len(sub(o, c));
  const r = add(c, mul(d, ol / L));
  const out: V = [r[0] / aspect, r[1]];
  if (moved === 'LEFT') p.handle_right = out;
  else p.handle_left = out;
}

/** Point on the cubic segment from a to b at t. */
export function bezier(a: MaskPoint, b: MaskPoint, t: number): V {
  const u = 1 - t;
  const p0 = a.co,
    p1 = a.handle_right,
    p2 = b.handle_left,
    p3 = b.co;
  return [u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]];
}

export interface Sample {
  p: V;
  /** feather width (frame widths) */
  w: number;
  /** segment index and parameter (for inserting points) */
  seg: number;
  t: number;
}

/** Points along the spline (each segment `steps` samples; closed splines return to the start). */
export function sampleSpline(sp: MaskSpline, steps = 16): Sample[] {
  const pts = sp.points;
  const n = pts.length;
  if (!n) return [];
  if (n === 1) return [{ p: [...pts[0].co], w: pts[0].weight, seg: 0, t: 0 }];
  const segs = sp.use_cyclic ? n : n - 1;
  const out: Sample[] = [];
  const ease = (sp as { weight_interpolation?: string }).weight_interpolation === 'EASE';
  for (let s = 0; s < segs; s++) {
    const a = pts[s],
      b = pts[(s + 1) % n];
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const tw = ease ? t * t * (3 - 2 * t) : t;
      out.push({ p: bezier(a, b, t), w: a.weight + (b.weight - a.weight) * tw, seg: s, t });
    }
  }
  if (!sp.use_cyclic) {
    const last = pts[n - 1];
    out.push({ p: [...last.co], w: last.weight, seg: n - 2, t: 1 });
  }
  return out;
}

/** Signed area (aspect-corrected, positive when counter-clockwise with y up). */
export function signedArea(poly: V[], aspect = 1): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i],
      q = poly[(i + 1) % poly.length];
    a += p[0] * aspect * q[1] - q[0] * aspect * p[1];
  }
  return a / 2;
}

/**
 * The feather outline: each sample pushed outward along the curve normal by `w × frac`
 * (frame widths, aspect-correct). Closed splines only.
 */
export function featherOutline(samples: Sample[], aspect = 1, frac = 1, mode: 'EVEN' | 'SMOOTH' = 'EVEN'): V[] {
  const n = samples.length;
  if (n < 3) return samples.map((s) => s.p);
  const poly = samples.map((s) => s.p);
  const ccw = signedArea(poly, aspect) > 0;
  // Smooth: the tangent from samples further apart, so corners get rounded feather offsets
  const span = mode === 'SMOOTH' ? Math.max(1, Math.round(n / 16)) : 1;
  return samples.map((s, i) => {
    const a = samples[(i - span + n * span) % n].p,
      b = samples[(i + span) % n].p;
    let tx = (b[0] - a[0]) * aspect,
      ty = b[1] - a[1];
    const L = Math.hypot(tx, ty) || 1;
    tx /= L;
    ty /= L;
    // outward normal: right of the tangent for counter-clockwise outlines
    const nx = ccw ? ty : -ty,
      ny = ccw ? -tx : tx;
    const d = s.w * frac * aspect; // weight is in frame widths; y unit = frame height
    return [s.p[0] + (nx * d) / aspect, s.p[1] + ny * d] as V;
  });
}

// ---------------------------------------------------------------------------
// editing helpers

/** Split segment `seg` at `t` with a new point that keeps the curve's shape (de Casteljau). */
export function insertPoint(sp: MaskSpline, seg: number, t: number): MaskPoint {
  const n = sp.points.length;
  const a = sp.points[seg],
    b = sp.points[(seg + 1) % n];
  const p01 = lerp(a.co, a.handle_right, t),
    p12 = lerp(a.handle_right, b.handle_left, t),
    p23 = lerp(b.handle_left, b.co, t);
  const p012 = lerp(p01, p12, t),
    p123 = lerp(p12, p23, t);
  const m = lerp(p012, p123, t);
  const np = newPoint(m[0], m[1], 'ALIGNED');
  np.handle_left = p012;
  np.handle_right = p123;
  np.weight = a.weight + (b.weight - a.weight) * t;
  if (a.handle_type !== 'AUTO' && a.handle_type !== 'VECTOR') a.handle_right = p01;
  if (b.handle_type !== 'AUTO' && b.handle_type !== 'VECTOR') b.handle_left = p23;
  sp.points.splice(seg + 1, 0, np);
  return np;
}

/** Reverse the point order (handles swap sides). */
export function switchDirection(sp: MaskSpline) {
  sp.points.reverse();
  for (const p of sp.points) {
    [p.handle_left, p.handle_right] = [p.handle_right, p.handle_left];
    [p.select_left_handle, p.select_right_handle] = [p.select_right_handle, p.select_left_handle];
  }
}

/** Make closed splines counter-clockwise so feathers point outward consistently. */
export function makeConsistent(sp: MaskSpline, aspect = 1): boolean {
  if (!sp.use_cyclic || sp.points.length < 3) return false;
  if (signedArea(sampleSpline(sp, 4).map((s) => s.p), aspect) >= 0) return false;
  switchDirection(sp);
  return true;
}

/** A closed four-point circle (aspect-correct) of radius `r` (frame heights) around (x, y). */
export function circleSpline(x: number, y: number, r: number, aspect = 1): MaskSpline {
  const k = 0.5522847498; // cubic approximation of a quarter circle
  const rx = r / aspect,
    ry = r;
  const pts: MaskPoint[] = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ].map(([cx, cy]) => {
    const p = newPoint(x + cx * rx, y + cy * ry, 'ALIGNED');
    // tangent (counter-clockwise)
    const tx = -cy,
      ty = cx;
    p.handle_left = [p.co[0] - tx * rx * k, p.co[1] - ty * ry * k];
    p.handle_right = [p.co[0] + tx * rx * k, p.co[1] + ty * ry * k];
    return p;
  });
  return { points: pts, use_cyclic: true, use_fill: true };
}

/** A closed square of half-size `r` (frame heights) around (x, y). */
export function squareSpline(x: number, y: number, r: number, aspect = 1): MaskSpline {
  const rx = r / aspect,
    ry = r;
  const sp: MaskSpline = {
    points: [
      [x - rx, y - ry],
      [x + rx, y - ry],
      [x + rx, y + ry],
      [x - rx, y + ry],
    ].map(([px, py]) => newPoint(px, py, 'VECTOR')),
    use_cyclic: true,
    use_fill: true,
  };
  recalcHandles(sp, aspect);
  return sp;
}

// ---------------------------------------------------------------------------
// shape keys

const PER_POINT = 7;

export function layerData(layer: MaskLayer): number[] {
  const out: number[] = [];
  for (const sp of layer.splines) for (const p of sp.points) out.push(p.co[0], p.co[1], p.handle_left[0], p.handle_left[1], p.handle_right[0], p.handle_right[1], p.weight);
  return out;
}

function pointCount(layer: MaskLayer) {
  return layer.splines.reduce((n, s) => n + s.points.length, 0);
}

/** Shape-key data interpolated at a frame (null without usable keys). */
export function keyedData(layer: MaskLayer, frame: number): number[] | null {
  const n = pointCount(layer) * PER_POINT;
  const keys = layer.shape_keys.filter((k) => k.data.length === n).sort((a, b) => a.frame - b.frame);
  if (!keys.length) return null;
  if (frame <= keys[0].frame) return keys[0].data;
  const last = keys[keys.length - 1];
  if (frame >= last.frame) return last.data;
  for (let i = 1; i < keys.length; i++)
    if (frame <= keys[i].frame) {
      const a = keys[i - 1],
        b = keys[i];
      const t = (frame - a.frame) / (b.frame - a.frame);
      return a.data.map((v, j) => v + (b.data[j] - v) * t);
    }
  return last.data;
}

/** Write shape-key data into the layer's points. */
export function applyData(layer: MaskLayer, data: number[]) {
  let i = 0;
  for (const sp of layer.splines)
    for (const p of sp.points) {
      p.co = [data[i], data[i + 1]];
      p.handle_left = [data[i + 2], data[i + 3]];
      p.handle_right = [data[i + 4], data[i + 5]];
      p.weight = data[i + 6];
      i += PER_POINT;
    }
}

/** Store the current point positions as a key at `frame` (replacing a key there). */
export function insertShapeKey(layer: MaskLayer, frame: number): MaskShapeKey {
  const data = layerData(layer);
  const n = data.length;
  // keys from before a topology change cannot be blended any more
  layer.shape_keys = layer.shape_keys.filter((k) => k.frame !== frame && k.data.length === n);
  const key = { frame, data };
  layer.shape_keys.push(key);
  layer.shape_keys.sort((a, b) => a.frame - b.frame);
  return key;
}

/** Offset of a parented point at a frame (from the marker it follows). */
export type ParentResolver = (p: MaskPoint, frame: number) => V | null;

/** The layer as it is at a frame: keyed positions, then parent motion (applied to a copy). */
export function layerAt(layer: MaskLayer, frame: number, parent?: ParentResolver, useKeys = true): MaskLayer {
  const data = useKeys ? keyedData(layer, frame) : null;
  const parented = !!parent && layer.splines.some((s) => s.points.some((p) => p.parent));
  if (!data && !parented) return layer;
  const copy: MaskLayer = { ...layer, splines: layer.splines.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p })) })) };
  if (data) applyData(copy, data);
  if (parented)
    for (const s of copy.splines)
      for (const p of s.points) {
        const d = p.parent ? parent!(p, frame) : null;
        if (!d) continue;
        p.co = add(p.co, d);
        p.handle_left = add(p.handle_left, d);
        p.handle_right = add(p.handle_right, d);
      }
  return copy;
}
