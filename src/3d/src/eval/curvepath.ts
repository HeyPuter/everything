// Arc-length parametrised path of a curve's first spline (used by Follow Path, Clamp To and Spline IK).
import { Vector3 } from 'three';
import type { CurveData } from '../data/types';
import { sampleSpline } from './curve';

export interface CurvePath {
  points: Vector3[];
  radii: number[];
  tilts: number[];
  /** cumulative length at each point (one extra entry closing a cyclic path) */
  lengths: number[];
  total: number;
  cyclic: boolean;
}

const cache = new WeakMap<CurveData, { key: string; path: CurvePath | null }>();

/** Path along the first spline in curve space, or null when it has fewer than two points. */
export function curvePath(cu: CurveData): CurvePath | null {
  const sp = cu.splines[0];
  if (!sp) return null;
  const key = JSON.stringify(sp) + '|' + cu.resolution_u;
  const hit = cache.get(cu);
  if (hit && hit.key === key) return hit.path;
  const s = sampleSpline(sp, cu.resolution_u);
  let path: CurvePath | null = null;
  if (s.points.length >= 2) {
    const points = s.points.map((p) => new Vector3(p[0], p[1], p[2]));
    const lengths = [0];
    for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + points[i].distanceTo(points[i - 1]));
    if (s.cyclic) lengths.push(lengths[lengths.length - 1] + points[0].distanceTo(points[points.length - 1]));
    path = { points, radii: s.radius, tilts: s.tilt, lengths, total: lengths[lengths.length - 1], cyclic: s.cyclic };
  }
  cache.set(cu, { key, path });
  return path;
}

export interface PathSample {
  point: Vector3;
  /** unit direction of travel */
  tangent: Vector3;
  radius: number;
  tilt: number;
}

/** Point at fraction `f` (0..1) of the path length. */
export function pathPoint(path: CurvePath, f: number): PathSample {
  const target = Math.max(0, Math.min(1, f)) * path.total;
  const L = path.lengths;
  const n = path.points.length;
  let lo = 1,
    hi = L.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (L[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.min(lo, L.length - 1);
  const a = path.points[(i - 1) % n],
    b = path.points[i % n];
  const seg = L[i] - L[i - 1];
  const t = seg > 1e-12 ? (target - L[i - 1]) / seg : 0;
  const ra = path.radii[(i - 1) % n] ?? 1,
    rb = path.radii[i % n] ?? 1;
  const ta = path.tilts[(i - 1) % n] ?? 0,
    tb = path.tilts[i % n] ?? 0;
  const tangent = b.clone().sub(a);
  if (tangent.lengthSq() < 1e-16) tangent.set(0, 1, 0);
  return { point: a.clone().lerp(b, t), tangent: tangent.normalize(), radius: ra + (rb - ra) * t, tilt: ta + (tb - ta) * t };
}
