// Curve Edit Mode geometry and selection kernels. Pure functions over CurveData so they can be
// unit tested without the viewport; the operators in ops-more.ts call these.
import { Vector3 } from 'three';
import type { BezierPoint, CurveData, HandleType, Spline, SplinePoint, Vec3 } from '../../data/types';

export interface PointRef {
  s: number;
  i: number;
}

const V3 = (a: ArrayLike<number>) => new Vector3(a[0], a[1], a[2]);
const arr = (v: Vector3) => [v.x, v.y, v.z] as Vec3;

export const pointCount = (sp: Spline) => (sp.type === 'BEZIER' ? sp.bezier_points.length : sp.points.length);
export const isHidden = (sp: Spline, i: number) => !!(sp.type === 'BEZIER' ? sp.bezier_points[i]?.hide : sp.points[i]?.hide);
export const isSel = (sp: Spline, i: number) => (sp.type === 'BEZIER' ? !!sp.bezier_points[i].select_control_point : !!sp.points[i].select);

export function setSel(sp: Spline, i: number, on: boolean) {
  if (on && isHidden(sp, i)) return;
  if (sp.type === 'BEZIER') {
    const b = sp.bezier_points[i];
    b.select_control_point = b.select_left_handle = b.select_right_handle = on;
  } else sp.points[i].select = on;
}

/** Any part of the point selected (control point or one of its handles). */
export function anyPartSelected(sp: Spline, i: number) {
  if (sp.type !== 'BEZIER') return !!sp.points[i].select;
  const b = sp.bezier_points[i];
  return !!(b.select_control_point || b.select_left_handle || b.select_right_handle);
}

export const pointCo = (sp: Spline, i: number): Vector3 => (sp.type === 'BEZIER' ? V3(sp.bezier_points[i].co) : V3(sp.points[i].co));

/** Index of the neighbour of `i` in direction `d` (±1), honouring cyclic splines; -1 at open ends. */
export function neighbour(sp: Spline, i: number, d: 1 | -1) {
  const n = pointCount(sp);
  const j = i + d;
  if (j >= 0 && j < n) return j;
  return sp.use_cyclic_u && n > 1 ? (j + n) % n : -1;
}

export function deselectAll(cu: CurveData) {
  for (const sp of cu.splines) for (let i = 0; i < pointCount(sp); i++) setSel(sp, i, false);
}

export function selectAll(cu: CurveData, action: 'TOGGLE' | 'SELECT' | 'DESELECT' | 'INVERT') {
  let a = action;
  if (a === 'TOGGLE') a = cu.splines.some((sp) => [...Array(pointCount(sp)).keys()].some((i) => !isHidden(sp, i) && anyPartSelected(sp, i))) ? 'DESELECT' : 'SELECT';
  for (const sp of cu.splines)
    for (let i = 0; i < pointCount(sp); i++) {
      if (isHidden(sp, i)) continue;
      setSel(sp, i, a === 'SELECT' ? true : a === 'DESELECT' ? false : !isSel(sp, i));
    }
}

/** (De)select the first or last point of every spline (toggles it). */
export function toggleEnds(cu: CurveData, which: 'FIRST' | 'LAST') {
  for (const sp of cu.splines) {
    const n = pointCount(sp);
    if (!n) continue;
    const i = which === 'FIRST' ? 0 : n - 1;
    if (!isHidden(sp, i)) setSel(sp, i, !isSel(sp, i));
  }
}

/** Select the point after (or before) every selected point. */
export function selectAdjacent(cu: CurveData, dir: 'NEXT' | 'PREVIOUS') {
  for (const sp of cu.splines) {
    const n = pointCount(sp);
    const sel = [...Array(n).keys()].map((i) => isSel(sp, i));
    for (let i = 0; i < n; i++) {
      if (!sel[i]) continue;
      const j = neighbour(sp, i, dir === 'NEXT' ? 1 : -1);
      if (j >= 0) setSel(sp, j, true);
    }
  }
}

export function selectMore(cu: CurveData) {
  for (const sp of cu.splines) {
    const n = pointCount(sp);
    const sel = [...Array(n).keys()].map((i) => isSel(sp, i));
    for (let i = 0; i < n; i++) {
      if (sel[i]) continue;
      const a = neighbour(sp, i, -1),
        b = neighbour(sp, i, 1);
      if ((a >= 0 && sel[a]) || (b >= 0 && sel[b])) setSel(sp, i, true);
    }
  }
}

/** Deselect selected points that have an unselected (or missing, at open ends) neighbour. */
export function selectLess(cu: CurveData) {
  for (const sp of cu.splines) {
    const n = pointCount(sp);
    const sel = [...Array(n).keys()].map((i) => isSel(sp, i));
    if (sel.every(Boolean) && sp.use_cyclic_u) continue;
    for (let i = 0; i < n; i++) {
      if (!sel[i]) continue;
      const a = neighbour(sp, i, -1),
        b = neighbour(sp, i, 1);
      const edge = (a < 0 || !sel[a]) && (b < 0 || !sel[b]) ? true : (a >= 0 && !sel[a]) || (b >= 0 && !sel[b]);
      // open spline ends stay selected when their only neighbour is selected
      if (edge) setSel(sp, i, false);
    }
  }
}

/** Seeded pseudo random generator (deterministic for the redo panel). */
export function rng(seed: number) {
  let s = (Math.floor(seed) * 7919 + 1) % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export function selectRandom(cu: CurveData, ratio: number, seed: number, action: 'SELECT' | 'DESELECT') {
  const r = rng(seed);
  for (const sp of cu.splines)
    for (let i = 0; i < pointCount(sp); i++) {
      if (isHidden(sp, i)) continue;
      if (r() < ratio) setSel(sp, i, action === 'SELECT');
    }
}

/**
 * Checker deselect: walking each spline from the active point (or the first selected point),
 * keep `nth` selected points then deselect `skip`, repeating.
 */
export function selectNth(cu: CurveData, skip: number, nth: number, offset: number, active: PointRef | null) {
  const period = Math.max(1, skip) + Math.max(1, nth);
  cu.splines.forEach((sp, s) => {
    const n = pointCount(sp);
    const sel = [...Array(n).keys()].filter((i) => isSel(sp, i));
    if (!sel.length) return;
    const start = active && active.s === s && isSel(sp, active.i) ? active.i : sel[0];
    for (const i of sel) {
      const d = sp.use_cyclic_u ? (i - start + n) % n : Math.abs(i - start);
      const keep = (((d + offset) % period) + period) % period < Math.max(1, nth);
      if (!keep) setSel(sp, i, false);
    }
  });
}

export function selectLinked(cu: CurveData) {
  for (const sp of cu.splines) {
    const n = pointCount(sp);
    if ([...Array(n).keys()].some((i) => anyPartSelected(sp, i))) for (let i = 0; i < n; i++) setSel(sp, i, true);
  }
}

export function selectSpline(cu: CurveData, s: number, deselect: boolean) {
  const sp = cu.splines[s];
  if (!sp) return;
  for (let i = 0; i < pointCount(sp); i++) setSel(sp, i, !deselect);
}

/** Select every point on the shorter way between two points of the same spline. */
export function selectPath(cu: CurveData, from: PointRef, to: PointRef) {
  if (from.s !== to.s) return false;
  const sp = cu.splines[from.s];
  const n = pointCount(sp);
  let a = from.i,
    b = to.i;
  if (sp.use_cyclic_u) {
    const fwd = (b - a + n) % n,
      back = (a - b + n) % n;
    const step = fwd <= back ? 1 : -1;
    for (let k = 0, i = a; k <= Math.min(fwd, back); k++, i = (i + step + n) % n) setSel(sp, i, true);
    return true;
  }
  if (a > b) [a, b] = [b, a];
  for (let i = a; i <= b; i++) setSel(sp, i, true);
  return true;
}

function tangent(sp: Spline, i: number): Vector3 {
  if (sp.type === 'BEZIER') {
    const b = sp.bezier_points[i];
    const t = V3(b.handle_right).sub(V3(b.handle_left));
    if (t.lengthSq() > 1e-12) return t.normalize();
  }
  const a = neighbour(sp, i, -1),
    c = neighbour(sp, i, 1);
  const p = pointCo(sp, i);
  const t = (c >= 0 ? pointCo(sp, c) : p.clone()).sub(a >= 0 ? pointCo(sp, a) : p.clone());
  return t.lengthSq() > 1e-12 ? t.normalize() : new Vector3(1, 0, 0);
}

const weightOf = (sp: Spline, i: number) => (sp.type === 'BEZIER' ? 1 : sp.points[i].co[3]);
const radiusOf = (sp: Spline, i: number) => (sp.type === 'BEZIER' ? sp.bezier_points[i].radius : sp.points[i].radius);

/** Select points similar to the selected ones (spline type, radius, weight or direction). */
export function selectSimilar(cu: CurveData, type: 'TYPE' | 'RADIUS' | 'WEIGHT' | 'DIRECTION', compare: 'EQUAL' | 'GREATER' | 'LESS', threshold: number) {
  const refs: { sp: Spline; i: number }[] = [];
  for (const sp of cu.splines) for (let i = 0; i < pointCount(sp); i++) if (isSel(sp, i)) refs.push({ sp, i });
  if (!refs.length) return false;
  if (type === 'TYPE') {
    const types = new Set(refs.map((r) => r.sp.type));
    for (const sp of cu.splines) if (types.has(sp.type)) for (let i = 0; i < pointCount(sp); i++) setSel(sp, i, true);
    return true;
  }
  const cmp = (v: number, r: number) => (compare === 'EQUAL' ? Math.abs(v - r) <= threshold + 1e-6 : compare === 'GREATER' ? v >= r - threshold - 1e-6 : v <= r + threshold + 1e-6);
  if (type === 'DIRECTION') {
    const dirs = refs.map((r) => tangent(r.sp, r.i));
    for (const sp of cu.splines)
      for (let i = 0; i < pointCount(sp); i++) {
        const t = tangent(sp, i);
        // threshold is a fraction of a half turn
        if (dirs.some((d) => Math.acos(Math.max(-1, Math.min(1, d.dot(t)))) / Math.PI <= threshold + 1e-6)) setSel(sp, i, true);
      }
    return true;
  }
  const val = type === 'RADIUS' ? radiusOf : weightOf;
  const vals = refs.map((r) => val(r.sp, r.i));
  for (const sp of cu.splines)
    for (let i = 0; i < pointCount(sp); i++) {
      const v = val(sp, i);
      if (vals.some((r) => cmp(v, r))) setSel(sp, i, true);
    }
  return true;
}

// ---------------------------------------------------------------------------
// hide / reveal

export function hidePoints(cu: CurveData, unselected: boolean) {
  for (const sp of cu.splines)
    for (let i = 0; i < pointCount(sp); i++) {
      const sel = anyPartSelected(sp, i);
      if (sel === unselected) continue;
      setSel(sp, i, false);
      if (sp.type === 'BEZIER') sp.bezier_points[i].hide = true;
      else sp.points[i].hide = true;
    }
}

export function revealPoints(cu: CurveData, select: boolean) {
  for (const sp of cu.splines)
    for (let i = 0; i < pointCount(sp); i++) {
      if (!isHidden(sp, i)) continue;
      if (sp.type === 'BEZIER') sp.bezier_points[i].hide = false;
      else sp.points[i].hide = false;
      if (select) setSel(sp, i, true);
    }
}

// ---------------------------------------------------------------------------
// handles

/** Automatic handle direction and lengths for a Bézier point (from its neighbours). */
export function autoHandles(sp: Spline, i: number): { left: Vector3; right: Vector3 } {
  const bp = sp.bezier_points;
  const co = V3(bp[i].co);
  const a = neighbour(sp, i, -1),
    c = neighbour(sp, i, 1);
  const prev = a >= 0 ? V3(bp[a].co) : null,
    next = c >= 0 ? V3(bp[c].co) : null;
  let dir: Vector3;
  if (prev && next) dir = next.clone().sub(prev);
  else if (next) dir = next.clone().sub(co);
  else if (prev) dir = co.clone().sub(prev);
  else dir = new Vector3(1, 0, 0);
  if (dir.lengthSq() < 1e-12) dir.set(1, 0, 0);
  dir.normalize();
  const dl = prev ? co.distanceTo(prev) : next ? co.distanceTo(next) : 1;
  const dr = next ? co.distanceTo(next) : dl;
  return { left: co.clone().addScaledVector(dir, -dl * 0.39), right: co.clone().addScaledVector(dir, dr * 0.39) };
}

/** Recalculate the handle directions of selected points (optionally their lengths too). */
export function makeNormalsConsistent(cu: CurveData, calcLength: boolean) {
  for (const sp of cu.splines) {
    if (sp.type !== 'BEZIER') continue;
    sp.bezier_points.forEach((b, i) => {
      if (!b.select_control_point && !b.select_left_handle && !b.select_right_handle) return;
      const auto = autoHandles(sp, i);
      const co = V3(b.co);
      for (const side of ['left', 'right'] as const) {
        const key = side === 'left' ? 'handle_left' : 'handle_right';
        const t = side === 'left' ? b.handle_left_type : b.handle_right_type;
        if (t === 'VECTOR') continue;
        const target = auto[side].clone().sub(co);
        const len = calcLength ? target.length() : V3(b[key]).distanceTo(co);
        if (target.lengthSq() < 1e-12) continue;
        b[key] = arr(co.clone().addScaledVector(target.normalize(), len));
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Bézier evaluation and fitting

export function bezierAt(p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3, t: number) {
  const u = 1 - t;
  return p0
    .clone()
    .multiplyScalar(u * u * u)
    .addScaledVector(p1, 3 * u * u * t)
    .addScaledVector(p2, 3 * u * t * t)
    .addScaledVector(p3, t * t * t);
}

/** Dense samples of the original curve between points a and b (walking forward). */
function sampleRun(sp: Spline, a: number, b: number, perSeg = 12): Vector3[] {
  const bp = sp.bezier_points,
    n = bp.length;
  const out: Vector3[] = [V3(bp[a].co)];
  for (let i = a; i !== b; i = (i + 1) % n) {
    const j = (i + 1) % n;
    const p0 = V3(bp[i].co),
      p1 = V3(bp[i].handle_right),
      p2 = V3(bp[j].handle_left),
      p3 = V3(bp[j].co);
    for (let k = 1; k <= perSeg; k++) out.push(bezierAt(p0, p1, p2, p3, k / perSeg));
  }
  return out;
}

/** Chord-length parameters (0..1) of a polyline. */
export function chordParams(pts: Vector3[]): number[] {
  const d: number[] = [0];
  for (let i = 1; i < pts.length; i++) d.push(d[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const total = d[d.length - 1] || 1;
  return d.map((x) => x / total);
}

/**
 * Least-squares fit of a single cubic between the first and last sample with fixed tangent
 * directions at both ends, for the given sample parameters. Returns the two inner control points.
 */
export function fitCubicParams(pts: Vector3[], u: number[], t0: Vector3, t1: Vector3): [Vector3, Vector3] {
  const p0 = pts[0],
    p3 = pts[pts.length - 1];
  let c00 = 0,
    c01 = 0,
    c11 = 0,
    x0 = 0,
    x1 = 0;
  for (let i = 0; i < pts.length; i++) {
    const t = u[i],
      v = 1 - t;
    const b0 = v * v * v,
      b1 = 3 * v * v * t,
      b2 = 3 * v * t * t,
      b3 = t * t * t;
    const a1 = t0.clone().multiplyScalar(b1),
      a2 = t1.clone().multiplyScalar(b2);
    c00 += a1.dot(a1);
    c01 += a1.dot(a2);
    c11 += a2.dot(a2);
    const tmp = pts[i].clone().sub(p0.clone().multiplyScalar(b0 + b1)).sub(p3.clone().multiplyScalar(b2 + b3));
    x0 += a1.dot(tmp);
    x1 += a2.dot(tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let alpha = 0,
    beta = 0;
  if (Math.abs(det) > 1e-12) {
    alpha = (x0 * c11 - x1 * c01) / det;
    beta = (c00 * x1 - c01 * x0) / det;
  }
  const seg = p0.distanceTo(p3);
  // degenerate or backwards solutions fall back to the classic third-of-the-chord heuristic
  if (!(alpha > 1e-6 * seg) || !(beta > 1e-6 * seg) || !Number.isFinite(alpha) || !Number.isFinite(beta)) alpha = beta = seg / 3;
  return [p0.clone().addScaledVector(t0, alpha), p3.clone().addScaledVector(t1, beta)];
}

/** Fit with chord-length parametrisation. */
export function fitCubic(pts: Vector3[], t0: Vector3, t1: Vector3): [Vector3, Vector3] {
  return fitCubicParams(pts, chordParams(pts), t0, t1);
}

/** Outgoing tangent direction of point i (towards i+1), and incoming one of j (towards j-1). */
function outDir(sp: Spline, i: number, toward: number): Vector3 {
  const b = sp.bezier_points[i];
  const t = V3(b.handle_right).sub(V3(b.co));
  if (t.lengthSq() > 1e-12) return t.normalize();
  const d = V3(sp.bezier_points[toward].co).sub(V3(b.co));
  return d.lengthSq() > 1e-12 ? d.normalize() : new Vector3(1, 0, 0);
}
function inDir(sp: Spline, j: number, toward: number): Vector3 {
  const b = sp.bezier_points[j];
  const t = V3(b.handle_left).sub(V3(b.co));
  if (t.lengthSq() > 1e-12) return t.normalize();
  const d = V3(sp.bezier_points[toward].co).sub(V3(b.co));
  return d.lengthSq() > 1e-12 ? d.normalize() : new Vector3(-1, 0, 0);
}

/** Replace the handles facing the removed run between a and b so the shape is kept. */
function refitBetween(sp: Spline, a: number, b: number) {
  const pts = sampleRun(sp, a, b);
  const [h1, h2] = fitCubic(pts, outDir(sp, a, (a + 1) % sp.bezier_points.length), inDir(sp, b, (b - 1 + sp.bezier_points.length) % sp.bezier_points.length));
  const A = sp.bezier_points[a],
    B = sp.bezier_points[b];
  const fix = (bp: BezierPoint, side: 'handle_left_type' | 'handle_right_type') => {
    if (bp[side] === 'AUTO' || bp[side] === 'VECTOR') bp[side] = 'ALIGNED';
  };
  A.handle_right = arr(h1);
  fix(A, 'handle_right_type');
  B.handle_left = arr(h2);
  fix(B, 'handle_left_type');
  // an automatic handle opposite an aligned one must not swing around
  if (A.handle_left_type === 'AUTO') A.handle_left_type = 'ALIGNED';
  if (B.handle_right_type === 'AUTO') B.handle_right_type = 'ALIGNED';
}

/** Removable points of a spline for dissolve: selected, not an open end. */
function dissolvable(sp: Spline, i: number) {
  const n = pointCount(sp);
  if (!isSel(sp, i)) return false;
  return sp.use_cyclic_u || (i > 0 && i < n - 1);
}

/** Dissolve selected points, keeping the curve shape as close as possible (Bézier refit). */
export function dissolveVerts(cu: CurveData) {
  const out: Spline[] = [];
  for (const sp of cu.splines) {
    const n = pointCount(sp);
    const kill = [...Array(n).keys()].map((i) => dissolvable(sp, i));
    if (!kill.some(Boolean)) {
      out.push(sp);
      continue;
    }
    // removing everything leaves nothing
    if (kill.every(Boolean) || n - kill.filter(Boolean).length < (sp.use_cyclic_u ? 2 : 1)) {
      if (!sp.use_cyclic_u) out.push(sp);
      continue;
    }
    if (sp.type === 'BEZIER') {
      // refit each removed run between its two kept neighbours (on the original geometry)
      const fits: { a: number; b: number; h1: Vec3; h2: Vec3 }[] = [];
      const work = structuredClone(sp);
      for (let a = 0; a < n; a++) {
        if (kill[a]) continue;
        const nxt = (a + 1) % n;
        if (!sp.use_cyclic_u && a === n - 1) continue;
        if (!kill[nxt]) continue;
        let b = nxt;
        while (kill[b]) b = (b + 1) % n;
        refitBetween(work, a, b);
        fits.push({ a, b, h1: work.bezier_points[a].handle_right, h2: work.bezier_points[b].handle_left });
      }
      for (const f of fits) {
        const A = sp.bezier_points[f.a],
          B = sp.bezier_points[f.b];
        A.handle_right = f.h1;
        B.handle_left = f.h2;
        A.handle_right_type = work.bezier_points[f.a].handle_right_type;
        A.handle_left_type = work.bezier_points[f.a].handle_left_type;
        B.handle_left_type = work.bezier_points[f.b].handle_left_type;
        B.handle_right_type = work.bezier_points[f.b].handle_right_type;
      }
      sp.bezier_points = sp.bezier_points.filter((_, i) => !kill[i]);
    } else sp.points = sp.points.filter((_, i) => !kill[i]);
    if (pointCount(sp) < 3 && sp.use_cyclic_u && sp.type !== 'BEZIER') sp.use_cyclic_u = false;
    out.push(sp);
  }
  cu.splines = out;
}

/** Maximum deviation between the original run a..b and a single refit cubic. */
function dissolveError(sp: Spline, a: number, b: number): number {
  const pts = sampleRun(sp, a, b, 8);
  const [h1, h2] = fitCubic(pts, outDir(sp, a, (a + 1) % sp.bezier_points.length), inDir(sp, b, (b - 1 + sp.bezier_points.length) % sp.bezier_points.length));
  const p0 = pts[0],
    p3 = pts[pts.length - 1];
  const curve: Vector3[] = [];
  for (let k = 0; k <= 32; k++) curve.push(bezierAt(p0, h1, h2, p3, k / 32));
  let err = 0;
  for (const p of pts) {
    let best = Infinity;
    for (const q of curve) best = Math.min(best, p.distanceToSquared(q));
    err = Math.max(err, best);
  }
  return Math.sqrt(err);
}

/** Simplify selected Bézier splines down to `ratio` of their points, removing the least significant points first. */
export function decimate(cu: CurveData, ratio: number) {
  let changed = false;
  for (const sp of cu.splines) {
    if (sp.type !== 'BEZIER') continue;
    const n = sp.bezier_points.length;
    if (!sp.bezier_points.some((b) => b.select_control_point)) continue;
    const target = Math.max(sp.use_cyclic_u ? 3 : 2, Math.round(n * Math.max(0, Math.min(1, ratio))));
    while (sp.bezier_points.length > target) {
      const m = sp.bezier_points.length;
      let best = -1,
        bestErr = Infinity;
      for (let i = 0; i < m; i++) {
        if (!dissolvable(sp, i)) continue;
        const a = (i - 1 + m) % m,
          b = (i + 1) % m;
        const e = dissolveError(sp, a, b);
        if (e < bestErr) {
          bestErr = e;
          best = i;
        }
      }
      if (best < 0) break;
      const a = (best - 1 + m) % m,
        b = (best + 1) % m;
      refitBetween(sp, a, b);
      sp.bezier_points.splice(best, 1);
      changed = true;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// smoothing and attribute setting

/** Move selected points a sixth of the way towards the average of their neighbours (handles follow). */
export function smoothPositions(cu: CurveData) {
  for (const sp of cu.splines) {
    const n = pointCount(sp);
    const orig = [...Array(n).keys()].map((i) => pointCo(sp, i));
    for (let i = 0; i < n; i++) {
      if (!isSel(sp, i)) continue;
      const a = neighbour(sp, i, -1),
        c = neighbour(sp, i, 1);
      if (a < 0 || c < 0) continue;
      const avg = orig[a].clone().add(orig[c]).multiplyScalar(0.5);
      const d = avg.sub(orig[i]).multiplyScalar(1 / 6);
      if (sp.type === 'BEZIER') {
        const b = sp.bezier_points[i];
        b.co = arr(V3(b.co).add(d));
        b.handle_left = arr(V3(b.handle_left).add(d));
        b.handle_right = arr(V3(b.handle_right).add(d));
      } else {
        const p = sp.points[i];
        p.co = [p.co[0] + d.x, p.co[1] + d.y, p.co[2] + d.z, p.co[3]];
      }
    }
  }
}

type Attr = 'radius' | 'tilt' | 'weight';
function getAttr(sp: Spline, i: number, k: Attr) {
  if (k === 'weight') return weightOf(sp, i);
  return sp.type === 'BEZIER' ? sp.bezier_points[i][k] : sp.points[i][k];
}
function setAttr(sp: Spline, i: number, k: Attr, v: number) {
  if (k === 'weight') {
    if (sp.type !== 'BEZIER') sp.points[i].co[3] = v;
    return;
  }
  if (sp.type === 'BEZIER') sp.bezier_points[i][k] = v;
  else sp.points[i][k] = v;
}

/**
 * Smooth an attribute over runs of selected points. Unselected neighbours (and open spline
 * ends) act as fixed boundary values; values relax towards a smooth transition.
 */
export function smoothAttribute(cu: CurveData, key: Attr, iterations = 20) {
  for (const sp of cu.splines) {
    if (key === 'weight' && sp.type === 'BEZIER') continue;
    const n = pointCount(sp);
    const sel = [...Array(n).keys()].map((i) => isSel(sp, i));
    if (!sel.some(Boolean)) continue;
    const vals = [...Array(n).keys()].map((i) => getAttr(sp, i, key));
    for (let it = 0; it < iterations; it++) {
      const next = vals.slice();
      for (let i = 0; i < n; i++) {
        if (!sel[i]) continue;
        const a = neighbour(sp, i, -1),
          c = neighbour(sp, i, 1);
        if (a < 0 || c < 0) continue;
        next[i] = vals[i] + 0.5 * ((vals[a] + vals[c]) / 2 - vals[i]);
      }
      vals.splice(0, n, ...next);
    }
    for (let i = 0; i < n; i++) if (sel[i]) setAttr(sp, i, key, vals[i]);
  }
}

export function setRadius(cu: CurveData, radius: number) {
  for (const sp of cu.splines) for (let i = 0; i < pointCount(sp); i++) if (isSel(sp, i)) setAttr(sp, i, 'radius', radius);
}

export function setWeight(cu: CurveData, weight: number) {
  let any = false;
  for (const sp of cu.splines) {
    if (sp.type === 'BEZIER') continue;
    for (let i = 0; i < sp.points.length; i++)
      if (sp.points[i].select) {
        sp.points[i].co[3] = weight;
        any = true;
      }
  }
  return any;
}

export function setSmooth(cu: CurveData, smooth: boolean) {
  for (const sp of cu.splines) if ([...Array(pointCount(sp)).keys()].some((i) => isSel(sp, i))) sp.use_smooth = smooth;
}

// ---------------------------------------------------------------------------
// topology

function sliceSpline(sp: Spline, idx: number[], cyclic: boolean): Spline {
  return {
    ...structuredClone({ ...sp, bezier_points: [], points: [] }),
    use_cyclic_u: cyclic,
    bezier_points: sp.type === 'BEZIER' ? idx.map((i) => structuredClone(sp.bezier_points[i])) : [],
    points: sp.type === 'BEZIER' ? [] : idx.map((i) => structuredClone(sp.points[i])),
  };
}

/** Copies of the selected runs of every spline (a fully selected cyclic spline stays cyclic). */
export function selectedRuns(cu: CurveData): Spline[] {
  const out: Spline[] = [];
  for (const sp of cu.splines) {
    const n = pointCount(sp);
    const sel = [...Array(n).keys()].map((i) => isSel(sp, i));
    if (!sel.some(Boolean)) continue;
    if (sel.every(Boolean)) {
      out.push(sliceSpline(sp, [...Array(n).keys()], sp.use_cyclic_u));
      continue;
    }
    // for cyclic splines start right after an unselected point so runs don't wrap
    const start = sp.use_cyclic_u ? (sel.indexOf(false) + 1) % n : 0;
    let run: number[] = [];
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      if (sel[i]) run.push(i);
      else if (run.length) {
        out.push(sliceSpline(sp, run, false));
        run = [];
      }
    }
    if (run.length) out.push(sliceSpline(sp, run, false));
  }
  return out;
}

/**
 * Remove every segment whose two end points are selected; pieces that end up fully selected
 * are dropped. With `dropSelected=false` this is "Delete Segments".
 */
export function cutSelectedSegments(cu: CurveData, dropSelected: boolean) {
  const out: Spline[] = [];
  for (const sp of cu.splines) {
    const n = pointCount(sp);
    const sel = [...Array(n).keys()].map((i) => isSel(sp, i));
    const cut = (i: number) => sel[i] && sel[(i + 1) % n];
    const segs = sp.use_cyclic_u && n > 1 ? n : n - 1;
    const firstCut = [...Array(Math.max(0, segs)).keys()].find(cut);
    if (firstCut === undefined) {
      if (!(dropSelected && n && sel.every(Boolean))) out.push(sp);
      continue;
    }
    const pieces: number[][] = [];
    const start = sp.use_cyclic_u ? (firstCut + 1) % n : 0;
    let piece = [start];
    for (let k = 0; k < n - 1; k++) {
      const i = (start + k) % n;
      if (cut(i)) {
        pieces.push(piece);
        piece = [(i + 1) % n];
      } else piece.push((i + 1) % n);
    }
    pieces.push(piece);
    for (const p of pieces) {
      if (dropSelected ? p.every((i) => sel[i]) : p.length < 2) continue;
      out.push(sliceSpline(sp, p, false));
    }
  }
  cu.splines = out;
}

/**
 * Split: the selected runs become new splines (selected); the remaining geometry loses the
 * segments between selected points.
 */
export function splitSelected(cu: CurveData): Spline[] {
  const runs = selectedRuns(cu);
  if (!runs.length) return [];
  cutSelectedSegments(cu, true);
  deselectAll(cu);
  for (const r of runs) for (let i = 0; i < pointCount(r); i++) setSel(r, i, true);
  cu.splines.push(...runs);
  return runs;
}

/** Remove the selected runs from `cu` (split semantics) and return them, for a separate object. */
export function extractSelected(cu: CurveData): Spline[] {
  const runs = selectedRuns(cu);
  if (!runs.length) return [];
  cutSelectedSegments(cu, true);
  return runs;
}

// ---------------------------------------------------------------------------
// subdivision

function splitBezier(a: BezierPoint, b: BezierPoint, t: number): { mid: BezierPoint; aR: Vec3; bL: Vec3 } {
  const p0 = V3(a.co),
    p1 = V3(a.handle_right),
    p2 = V3(b.handle_left),
    p3 = V3(b.co);
  const q0 = p0.clone().lerp(p1, t),
    q1 = p1.clone().lerp(p2, t),
    q2 = p2.clone().lerp(p3, t);
  const r0 = q0.clone().lerp(q1, t),
    r1 = q1.clone().lerp(q2, t);
  const s = r0.clone().lerp(r1, t);
  const vec = a.handle_right_type === 'VECTOR' && b.handle_left_type === 'VECTOR';
  const type: HandleType = vec ? 'VECTOR' : a.handle_right_type === 'AUTO' && b.handle_left_type === 'AUTO' ? 'AUTO' : 'ALIGNED';
  const mid: BezierPoint = {
    co: arr(s),
    handle_left: arr(r0),
    handle_right: arr(r1),
    handle_left_type: type === 'AUTO' ? 'ALIGNED' : type,
    handle_right_type: type === 'AUTO' ? 'ALIGNED' : type,
    radius: a.radius + (b.radius - a.radius) * t,
    tilt: a.tilt + (b.tilt - a.tilt) * t,
  };
  return { mid, aR: arr(q0), bL: arr(q2) };
}

/** Subdivide every segment between two selected points into `cuts + 1` equal parameter steps. */
export function subdivide(cu: CurveData, cuts: number) {
  for (const sp of cu.splines) {
    const n = pointCount(sp);
    const segs = sp.use_cyclic_u ? n : n - 1;
    const sel = [...Array(n).keys()].map((i) => isSel(sp, i));
    // walk backwards so indices stay valid while inserting
    for (let i = segs - 1; i >= 0; i--) {
      const j = (i + 1) % n;
      if (!sel[i] || !sel[j]) continue;
      if (sp.type === 'BEZIER') {
        let a = sp.bezier_points[i];
        const b = sp.bezier_points[j];
        const inserted: BezierPoint[] = [];
        // split off the first part repeatedly: t = 1/(k+1) of what remains gives equal parameter steps
        for (let k = cuts; k >= 1; k--) {
          const { mid, aR, bL } = splitBezier(a, b, 1 / (k + 1));
          if (a.handle_right_type !== 'VECTOR') a.handle_right = aR;
          if (b.handle_left_type !== 'VECTOR') b.handle_left = bL;
          if (a.handle_right_type === 'AUTO') a.handle_right_type = 'ALIGNED';
          if (b.handle_left_type === 'AUTO') b.handle_left_type = 'ALIGNED';
          mid.select_control_point = mid.select_left_handle = mid.select_right_handle = true;
          inserted.push(mid);
          a = mid;
        }
        sp.bezier_points.splice(i + 1, 0, ...inserted);
      } else {
        const a = sp.points[i],
          b = sp.points[j];
        const pts: SplinePoint[] = [];
        for (let k = 1; k <= cuts; k++) {
          const t = k / (cuts + 1);
          pts.push({ co: a.co.map((x, c) => x + (b.co[c] - x) * t) as SplinePoint['co'], radius: a.radius + (b.radius - a.radius) * t, tilt: a.tilt + (b.tilt - a.tilt) * t, select: true });
        }
        sp.points.splice(i + 1, 0, ...pts);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// freehand stroke fitting (Draw tool)

type Seg = [Vector3, Vector3, Vector3, Vector3];

function bezierDeriv(c: Seg, t: number) {
  const u = 1 - t;
  return c[1]
    .clone()
    .sub(c[0])
    .multiplyScalar(3 * u * u)
    .addScaledVector(c[2].clone().sub(c[1]), 6 * u * t)
    .addScaledVector(c[3].clone().sub(c[2]), 3 * t * t);
}
function bezierDeriv2(c: Seg, t: number) {
  const u = 1 - t;
  return c[2]
    .clone()
    .sub(c[1].clone().multiplyScalar(2))
    .add(c[0])
    .multiplyScalar(6 * u)
    .addScaledVector(c[3].clone().sub(c[2].clone().multiplyScalar(2)).add(c[1]), 6 * t);
}

function maxError(c: Seg, pts: Vector3[], u: number[]): { err: number; at: number } {
  let err = 0,
    at = Math.floor(pts.length / 2);
  for (let i = 1; i < pts.length - 1; i++) {
    const d = bezierAt(c[0], c[1], c[2], c[3], u[i]).distanceToSquared(pts[i]);
    if (d > err) {
      err = d;
      at = i;
    }
  }
  return { err: Math.sqrt(err), at };
}

function fitPiece(pts: Vector3[], t0: Vector3, t1: Vector3, error: number, out: Seg[], depth = 0) {
  if (pts.length === 2) {
    const d = pts[0].distanceTo(pts[1]) / 3;
    out.push([pts[0], pts[0].clone().addScaledVector(t0, d), pts[1].clone().addScaledVector(t1, d), pts[1]]);
    return;
  }
  let u = chordParams(pts);
  let [h1, h2] = fitCubicParams(pts, u, t0, t1);
  let c: Seg = [pts[0], h1, h2, pts[pts.length - 1]];
  let { err, at } = maxError(c, pts, u);
  // a few Newton steps on the parametrisation often avoid an unnecessary split
  for (let it = 0; it < 4 && err > error && err < error * 8; it++) {
    u = u.map((t, i) => {
      if (i === 0 || i === pts.length - 1) return t;
      const d = bezierAt(c[0], c[1], c[2], c[3], t).sub(pts[i]);
      const d1 = bezierDeriv(c, t),
        d2 = bezierDeriv2(c, t);
      const den = d1.dot(d1) + d.dot(d2);
      return Math.abs(den) < 1e-12 ? t : Math.max(0, Math.min(1, t - d.dot(d1) / den));
    });
    [h1, h2] = fitCubicParams(pts, u, t0, t1);
    c = [pts[0], h1, h2, pts[pts.length - 1]];
    ({ err, at } = maxError(c, pts, u));
  }
  if (err <= error || depth > 24) {
    out.push(c);
    return;
  }
  at = Math.max(1, Math.min(pts.length - 2, at));
  const tc = pts[at + 1].clone().sub(pts[at - 1]);
  if (tc.lengthSq() < 1e-16) tc.copy(pts[at + 1]).sub(pts[at]);
  tc.normalize();
  fitPiece(pts.slice(0, at + 1), t0, tc.clone().negate(), error, out, depth + 1);
  fitPiece(pts.slice(at), tc, t1, error, out, depth + 1);
}

function endTangent(pts: Vector3[], fromStart: boolean) {
  // look a tenth of the piece's length into the stroke so jitter at the very end doesn't dominate
  const n = pts.length;
  let total = 0;
  for (let i = 1; i < n; i++) total += pts[i].distanceTo(pts[i - 1]);
  let acc = 0,
    k = 1;
  for (; k < n - 1; k++) {
    acc += fromStart ? pts[k].distanceTo(pts[k - 1]) : pts[n - 1 - k].distanceTo(pts[n - k]);
    if (acc >= total / 10 && k >= 2) break;
  }
  const t = fromStart ? pts[k].clone().sub(pts[0]) : pts[n - 1 - k].clone().sub(pts[n - 1]);
  return t.lengthSq() > 1e-16 ? t.normalize() : new Vector3(1, 0, 0);
}

/**
 * Fit Bézier points to a freehand stroke: corners sharper than `cornerAngle` split the stroke,
 * every piece is fitted with cubic segments within `error` (world units). With `cyclic` and
 * a stroke ending near its start, the spline is closed.
 */
export function fitStroke(raw: Vector3[], error: number, cornerAngle: number, cyclic: boolean, radii?: number[]): { points: BezierPoint[]; cyclic: boolean } {
  const pts: Vector3[] = [],
    rad: number[] = [];
  raw.forEach((p, i) => {
    if (!pts.length || p.distanceTo(pts[pts.length - 1]) > 1e-6) {
      pts.push(p.clone());
      rad.push(radii?.[i] ?? 1);
    }
  });
  if (pts.length < 2) return { points: pts.length ? [{ co: arr(pts[0]), handle_left: arr(pts[0]), handle_right: arr(pts[0]), handle_left_type: 'AUTO', handle_right_type: 'AUTO', radius: rad[0], tilt: 0 }] : [], cyclic: false };
  // close the stroke when it ends near its start
  const total = pts.reduce((s, p, i) => (i ? s + p.distanceTo(pts[i - 1]) : 0), 0);
  let closed = false;
  if (cyclic && pts.length > 4 && pts[0].distanceTo(pts[pts.length - 1]) < Math.max(error * 4, total * 0.05)) {
    closed = true;
    pts[pts.length - 1] = pts[0].clone();
  }
  // corners: turning angle over a small window
  const corners: number[] = [];
  if (cornerAngle < Math.PI) {
    const w = 2;
    const ang = pts.map((_, i) => {
      if (i < w || i >= pts.length - w) return 0;
      const a = pts[i].clone().sub(pts[i - w]),
        b = pts[i + w].clone().sub(pts[i]);
      if (a.lengthSq() < 1e-16 || b.lengthSq() < 1e-16) return 0;
      return a.angleTo(b);
    });
    for (let i = w; i < pts.length - w; i++) if (ang[i] > cornerAngle && ang[i] >= ang[i - 1] && ang[i] >= ang[i + 1] && (!corners.length || i - corners[corners.length - 1] > w)) corners.push(i);
  }
  const bounds = [0, ...corners, pts.length - 1];
  const segs: Seg[] = [];
  const segCorner: boolean[] = []; // segment starts at a corner
  for (let k = 0; k + 1 < bounds.length; k++) {
    const piece = pts.slice(bounds[k], bounds[k + 1] + 1);
    if (piece.length < 2) continue;
    let t0 = endTangent(piece, true),
      t1 = endTangent(piece, false);
    // smooth closure: shared tangent at the seam
    if (closed && !corners.length) {
      const tc = pts[1].clone().sub(pts[pts.length - 2]).normalize();
      t0 = tc.clone();
      t1 = tc.clone().negate();
    }
    const before = segs.length;
    fitPiece(piece, t0, t1, Math.max(1e-5, error), segs);
    for (let i = before; i < segs.length; i++) segCorner.push(i === before && k > 0);
  }
  // radius per segment end (nearest raw sample)
  const radiusAt = (p: Vector3) => {
    let best = 0,
      bd = Infinity;
    pts.forEach((q, i) => {
      const d = q.distanceToSquared(p);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return rad[best];
  };
  const out: BezierPoint[] = [];
  segs.forEach((c, i) => {
    if (i === 0) {
      const mirrored = c[0].clone().multiplyScalar(2).sub(c[1]);
      out.push({ co: arr(c[0]), handle_left: arr(mirrored), handle_right: arr(c[1]), handle_left_type: 'ALIGNED', handle_right_type: 'ALIGNED', radius: radiusAt(c[0]), tilt: 0 });
    } else {
      const prev = out[out.length - 1];
      prev.handle_right = arr(c[1]);
      if (segCorner[i]) prev.handle_left_type = prev.handle_right_type = 'FREE';
    }
    const mirrored = c[3].clone().multiplyScalar(2).sub(c[2]);
    out.push({ co: arr(c[3]), handle_left: arr(c[2]), handle_right: arr(mirrored), handle_left_type: 'ALIGNED', handle_right_type: 'ALIGNED', radius: radiusAt(c[3]), tilt: 0 });
  });
  if (closed && out.length > 2) {
    const last = out.pop()!;
    out[0].handle_left = last.handle_left;
    if (corners.length) out[0].handle_left_type = out[0].handle_right_type = 'FREE';
  }
  return { points: out, cyclic: closed && out.length > 2 };
}

/** Split the segment after point i at parameter t, inserting a new point that keeps the shape. */
export function insertPointOnSegment(sp: Spline, i: number, t: number): number {
  const n = pointCount(sp);
  const j = (i + 1) % n;
  if (sp.type === 'BEZIER') {
    const a = sp.bezier_points[i],
      b = sp.bezier_points[j];
    const { mid, aR, bL } = splitBezier(a, b, t);
    if (a.handle_right_type === 'AUTO' || a.handle_right_type === 'ALIGNED' || a.handle_right_type === 'FREE') a.handle_right = aR;
    if (b.handle_left_type !== 'VECTOR') b.handle_left = bL;
    if (a.handle_right_type === 'AUTO') a.handle_right_type = a.handle_left_type = 'ALIGNED';
    if (b.handle_left_type === 'AUTO') b.handle_left_type = b.handle_right_type = 'ALIGNED';
    sp.bezier_points.splice(i + 1, 0, mid);
  } else {
    const a = sp.points[i],
      b = sp.points[j];
    sp.points.splice(i + 1, 0, { co: a.co.map((x, k) => x + (b.co[k] - x) * t) as SplinePoint['co'], radius: a.radius + (b.radius - a.radius) * t, tilt: a.tilt + (b.tilt - a.tilt) * t });
  }
  return i + 1;
}
