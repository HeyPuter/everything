// Bevel profile shapes: superellipse curves between the two ends of a bevel cross-section and
// the curved corner patch where three beveled edges meet. Pure geometry (unit tested).
import { Matrix3, Vector3 } from 'three';

/**
 * Superellipse exponent for a profile shape value: 0.25 is a straight chamfer, 0.5 a quarter
 * circle, values towards 1 bulge out to a square corner and towards 0 cave in.
 */
export function profileExponent(profile: number): number {
  const p = Math.min(0.9999, Math.max(1e-4, profile));
  return Math.log(0.25) / Math.log(p);
}

/**
 * `segs + 1` points (u, w) on the curve u^r + w^r = 1 from (0, 1) to (1, 0), spaced evenly by arc
 * length. Shapes very close to 0 or 1 follow the inner or outer corner of the unit square.
 */
export function profileSamples(segs: number, profile: number): [number, number][] {
  if (profile <= 1e-4 || profile >= 0.9999) {
    // two straight legs through the inner (0,0) or outer (1,1) corner
    const c = profile >= 0.9999 ? 1 : 0;
    return Array.from({ length: segs + 1 }, (_, i) => {
      const t = (i / segs) * 2;
      return t <= 1 ? [c * t, 1 - (1 - c) * t] : [c + (1 - c) * (t - 1), c - c * (t - 1)];
    });
  }
  const r = profileExponent(profile);
  if (Math.abs(r - 2) < 1e-9) return Array.from({ length: segs + 1 }, (_, i) => [Math.sin(((i / segs) * Math.PI) / 2), Math.cos(((i / segs) * Math.PI) / 2)]);
  if (Math.abs(r - 1) < 1e-9) return Array.from({ length: segs + 1 }, (_, i) => [i / segs, 1 - i / segs]);
  // dense polyline, then walk it at equal arc-length steps
  const N = 2048;
  const pts: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const th = ((i / N) * Math.PI) / 2;
    pts.push([Math.pow(Math.sin(th), 2 / r), Math.pow(Math.cos(th), 2 / r)]);
  }
  const acc = [0];
  for (let i = 1; i <= N; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = acc[N];
  const out: [number, number][] = [[0, 1]];
  let j = 1;
  for (let k = 1; k < segs; k++) {
    const target = (total * k) / segs;
    while (j < N && acc[j] < target) j++;
    const t = (target - acc[j - 1]) / Math.max(1e-12, acc[j] - acc[j - 1]);
    out.push([pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * t, pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * t]);
  }
  out.push([1, 0]);
  return out;
}

/**
 * Interior points (excluding the ends) of a bevel cross-section from `a` to `b` whose square corner
 * would be `mid`: the unit-square curve mapped by the parallelogram with corners a+b-mid, a, mid, b.
 */
export function profilePoints(a: Vector3, b: Vector3, mid: Vector3, segs: number, profile: number): Vector3[] {
  const c = a.clone().add(b).sub(mid);
  const ua = b.clone().sub(c),
    wa = a.clone().sub(c);
  return profileSamples(segs, profile)
    .slice(1, -1)
    .map(([u, w]) => c.clone().addScaledVector(ua, u).addScaledVector(wa, w));
}

/** Scale a non-negative point onto the superellipsoid x^r + y^r + z^r = 1. */
function toSurface(q: Vector3, r: number): Vector3 {
  const x = Math.max(0, q.x),
    y = Math.max(0, q.y),
    z = Math.max(0, q.z);
  const n = r === Infinity ? Math.max(x, y, z) : Math.pow(Math.pow(x, r) + Math.pow(y, r) + Math.pow(z, r), 1 / r);
  return n > 1e-12 ? new Vector3(x / n, y / n, z / n) : new Vector3(1 / 3, 1 / 3, 1 / 3);
}

export interface CornerPatch {
  /** new interior points (world) */
  points: Vector3[];
  /** faces as indices: >= 0 into `ring`, < 0 into `points` (-1 - i) */
  faces: number[][];
}

/**
 * Curved patch closing a corner where three bevel strips meet. `ring` holds the 3·segs boundary
 * positions in order, starting at a face corner (the corners are at 0, segs, 2·segs); `vertex` is
 * the original corner. The patch lies on the superellipsoid spanned by the three face corners.
 */
export function cornerPatchGeometry(ring: Vector3[], vertex: Vector3, segs: number, profile: number): CornerPatch | null {
  const ns = segs;
  if (ring.length !== 3 * ns || ns < 2) return null;
  const P = [ring[0], ring[ns], ring[2 * ns]];
  const origin = P[0].clone().add(P[1]).add(P[2]).sub(vertex).multiplyScalar(0.5);
  const axes = P.map((p) => p.clone().sub(origin));
  const M = new Matrix3().set(axes[0].x, axes[1].x, axes[2].x, axes[0].y, axes[1].y, axes[2].y, axes[0].z, axes[1].z, axes[2].z);
  if (Math.abs(M.determinant()) < 1e-12) return null;
  const inv = M.clone().invert();
  const r = profile >= 0.9999 ? Infinity : Math.max(0.2, profileExponent(profile));
  const toCanon = (p: Vector3) => p.clone().sub(origin).applyMatrix3(inv);
  const toWorld = (q: Vector3) => origin.clone().addScaledVector(axes[0], q.x).addScaledVector(axes[1], q.y).addScaledVector(axes[2], q.z);
  // flat domain: the triangle x + y + z = 1 (boundary points pushed onto it along rays from the origin)
  const flat = (q: Vector3) => {
    const s = Math.max(0, q.x) + Math.max(0, q.y) + Math.max(0, q.z);
    return s > 1e-12 ? new Vector3(Math.max(0, q.x) / s, Math.max(0, q.y) / s, Math.max(0, q.z) / s) : new Vector3(1 / 3, 1 / 3, 1 / 3);
  };
  const B = ring.map((p) => flat(toCanon(p)));
  const G = new Vector3(1 / 3, 1 / 3, 1 / 3);
  const pts: Vector3[] = [];
  const add = (q: Vector3) => (pts.push(q), -pts.length);
  const at = (i: number) => ((i % (3 * ns)) + 3 * ns) % (3 * ns);
  const faces: number[][] = [];
  const posOf = (id: number) => (id >= 0 ? B[id] : pts[-1 - id]);
  /** a (k+1)×(k+1) grid over four sides given as id lists (bottom/top run along u, left/right along v) */
  const coons = (bottom: number[], top: number[], left: number[], right: number[]) => {
    const k = bottom.length - 1,
      l = left.length - 1;
    const g: number[][] = [];
    for (let j = 0; j <= l; j++) {
      const row: number[] = [];
      for (let i = 0; i <= k; i++) {
        if (j === 0) row.push(bottom[i]);
        else if (j === l) row.push(top[i]);
        else if (i === 0) row.push(left[j]);
        else if (i === k) row.push(right[j]);
        else {
          const u = i / k,
            v = j / l;
          const q = posOf(bottom[i])
            .clone()
            .multiplyScalar(1 - v)
            .addScaledVector(posOf(top[i]), v)
            .addScaledVector(posOf(left[j]), 1 - u)
            .addScaledVector(posOf(right[j]), u)
            .addScaledVector(posOf(bottom[0]), -(1 - u) * (1 - v))
            .addScaledVector(posOf(bottom[k]), -u * (1 - v))
            .addScaledVector(posOf(top[0]), -(1 - u) * v)
            .addScaledVector(posOf(top[k]), -u * v);
          row.push(add(q));
        }
      }
      g.push(row);
    }
    for (let j = 0; j < l; j++) for (let i = 0; i < k; i++) faces.push([g[j][i], g[j][i + 1], g[j + 1][i + 1], g[j + 1][i]]);
  };
  const line = (from: number, to: number, n: number) => {
    const out = [from];
    for (let i = 1; i < n; i++) out.push(add(posOf(from).clone().lerp(posOf(to), i / n)));
    out.push(to);
    return out;
  };
  if (ns % 2 === 0) {
    const k = ns / 2;
    const g = add(G.clone());
    // spokes from the middle of each side to the centre
    const spoke = [0, 1, 2].map((s) => line(at(s * ns + k), g, k));
    for (let c = 0; c < 3; c++) {
      // quadrant at corner c: from the corner along the side after it and along the side before it
      const after = Array.from({ length: k + 1 }, (_, i) => at(c * ns + i));
      const before = Array.from({ length: k + 1 }, (_, i) => at(c * ns - i));
      coons(after, spoke[(c + 2) % 3], before, spoke[c]);
    }
  } else {
    const k = (ns - 1) / 2;
    const inner = [0, 1, 2].map((c) => add(G.clone().lerp(B[c * ns], 0.5 / ns)));
    // spokes from both side points next to the middle of each side to the inner points
    const spokeA = [0, 1, 2].map((c) => line(at(c * ns + k), inner[c], k));
    const spokeB = [0, 1, 2].map((c) => line(at(c * ns + k + 1), inner[(c + 1) % 3], k));
    for (let c = 0; c < 3; c++) {
      const after = Array.from({ length: k + 1 }, (_, i) => at(c * ns + i));
      const before = Array.from({ length: k + 1 }, (_, i) => at(c * ns - i));
      if (k > 0) coons(after, spokeB[(c + 2) % 3], before, spokeA[c]);
      // strip between this corner's spoke and the next corner's along side c
      coons([at(c * ns + k), at(c * ns + k + 1)], [inner[c], inner[(c + 1) % 3]], spokeA[c], spokeB[c]);
    }
    faces.push([inner[0], inner[1], inner[2]]);
  }
  return { points: pts.map((q) => toWorld(toSurface(q, r))), faces };
}
