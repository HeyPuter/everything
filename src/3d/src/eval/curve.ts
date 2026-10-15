// Curve evaluation: Bézier/poly/NURBS splines → polylines → wire, tube (bevel),
// extruded ribbon, or filled 2D shapes.
import type { CurveData, Spline, Vec3 } from '../data/types';
import type { EvalMesh } from './types';
import { buildMesh, type PolyFace } from '../mesh/mesh';
import { ShapeUtils, Vector2 } from 'three';
import { textToCurves } from './text';

export interface SampledSpline {
  points: Vec3[];
  radius: number[];
  tilt: number[];
  cyclic: boolean;
  material: number;
  smooth: boolean;
}

function bez(p0: number, p1: number, p2: number, p3: number, t: number) {
  const m = 1 - t;
  return m * m * m * p0 + 3 * m * m * t * p1 + 3 * m * t * t * p2 + t * t * t * p3;
}

export function sampleSpline(s: Spline, resolution: number): SampledSpline {
  const pts: Vec3[] = [],
    rad: number[] = [],
    tilt: number[] = [];
  const res = Math.max(1, s.resolution_u || resolution);
  if (s.type === 'BEZIER') {
    const bp = s.bezier_points,
      n = bp.length;
    const segs = s.use_cyclic_u ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = bp[i],
        b = bp[(i + 1) % n];
      for (let k = 0; k < res; k++) {
        const t = k / res;
        pts.push([0, 1, 2].map((ax) => bez(a.co[ax], a.handle_right[ax], b.handle_left[ax], b.co[ax], t)) as Vec3);
        rad.push(a.radius + (b.radius - a.radius) * t);
        tilt.push(a.tilt + (b.tilt - a.tilt) * t);
      }
    }
    if (!s.use_cyclic_u && n) {
      pts.push([...bp[n - 1].co] as Vec3);
      rad.push(bp[n - 1].radius);
      tilt.push(bp[n - 1].tilt);
    }
  } else if (s.type === 'POLY') {
    for (const p of s.points) {
      pts.push([p.co[0], p.co[1], p.co[2]]);
      rad.push(p.radius);
      tilt.push(p.tilt);
    }
  } else {
    // NURBS: uniform B-spline evaluation with weights (endpoint optional)
    const cps = s.points,
      order = Math.max(2, Math.min(s.order_u || 4, cps.length));
    const n = cps.length;
    if (n >= 2) {
      const cyclic = s.use_cyclic_u;
      const ctrl = cyclic ? [...cps, ...cps.slice(0, order - 1)] : cps;
      const m = ctrl.length;
      const knots: number[] = [];
      const endpoint = !!s.use_endpoint_u && !cyclic;
      for (let i = 0; i < m + order; i++) {
        if (endpoint) knots.push(i < order ? 0 : i >= m ? m - order + 1 : i - order + 1);
        else knots.push(i);
      }
      const t0 = knots[order - 1],
        t1 = knots[m];
      const steps = res * (cyclic ? n : n - 1);
      for (let k = 0; k <= steps; k++) {
        if (cyclic && k === steps) break;
        const t = t0 + ((t1 - t0) * k) / steps - (k === steps ? 1e-9 : 0);
        let x = 0,
          y = 0,
          z = 0,
          w = 0,
          r = 0,
          tl = 0;
        for (let i = 0; i < m; i++) {
          const b = basis(i, order, t, knots) * (ctrl[i].co[3] || 1);
          x += ctrl[i].co[0] * b;
          y += ctrl[i].co[1] * b;
          z += ctrl[i].co[2] * b;
          r += ctrl[i].radius * b;
          tl += ctrl[i].tilt * b;
          w += b;
        }
        if (w > 0) {
          pts.push([x / w, y / w, z / w]);
          rad.push(r / w);
          tilt.push(tl / w);
        }
      }
    }
  }
  return { points: pts, radius: rad, tilt, cyclic: s.use_cyclic_u, material: s.material_index, smooth: s.use_smooth };
}

function basis(i: number, k: number, t: number, knots: number[]): number {
  if (k === 1) return knots[i] <= t && t < knots[i + 1] ? 1 : 0;
  let a = 0,
    b = 0;
  const d1 = knots[i + k - 1] - knots[i],
    d2 = knots[i + k] - knots[i + 1];
  if (d1 > 0) a = ((t - knots[i]) / d1) * basis(i, k - 1, t, knots);
  if (d2 > 0) b = ((knots[i + k] - t) / d2) * basis(i + 1, k - 1, t, knots);
  return a + b;
}

/** Parallel-transport frames along a polyline. */
export function frames(points: Vec3[], cyclic: boolean, planarZ: boolean) {
  const n = points.length;
  const T: Vec3[] = [],
    N: Vec3[] = [],
    B: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const prev = points[cyclic ? (i - 1 + n) % n : Math.max(0, i - 1)],
      next = points[cyclic ? (i + 1) % n : Math.min(n - 1, i + 1)];
    T.push(norm(sub(next, prev)));
  }
  let up: Vec3 = planarZ ? [0, 0, 1] : Math.abs(T[0]?.[2] ?? 0) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  for (let i = 0; i < n; i++) {
    if (!planarZ && i > 0) up = N[i - 1];
    let b = norm(cross(T[i], up));
    if (len(b) < 1e-6) b = norm(cross(T[i], [1, 0, 0]));
    const nn = norm(cross(b, T[i]));
    if (planarZ) {
      N.push([0, 0, 1]);
      B.push(norm(cross(T[i], [0, 0, 1])));
    } else {
      N.push(nn);
      B.push(b);
    }
  }
  return { T, N, B };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Extra shaping from other objects: a bevel profile (cross-section) and a taper (radius along the curve). */
export interface CurveShapeOptions {
  /** profile points in the cross-section plane (x: sideways, y: up), object units */
  profile?: [number, number][];
  profileClosed?: boolean;
  /** radius factor for a parameter 0..1 along each spline */
  taper?: (t: number) => number;
  /** splines to use instead of the curve's own (e.g. text bent along a path) */
  splines?: Spline[];
}

export function curveToMesh(cu: CurveData, isText = false, shape: CurveShapeOptions = {}): EvalMesh {
  const splines = shape.splines ?? (isText ? textToCurves(cu) : cu.splines);
  const sampled = splines.map((s) => sampleSpline(s, cu.resolution_u));
  const positions: number[] = [],
    faces: PolyFace[] = [];
  const curves: { points: Float32Array; cyclic: boolean }[] = [];
  const is2D = cu.dimensions === '2D' || isText;
  const add = (p: Vec3) => {
    positions.push(p[0], p[1], p[2]);
    return positions.length / 3 - 1;
  };
  const profile = shape.profile && shape.profile.length >= 2 ? shape.profile : null;
  const hasGeometry = cu.bevel_depth > 0 || cu.extrude > 0 || !!profile;
  // 2D fill
  if (is2D && cu.fill_mode !== 'NONE' && (cu.fill_mode as string) !== 'NONE') {
    const closed = sampled.filter((s) => s.cyclic && s.points.length >= 3);
    if (closed.length) {
      const fillAt = (z: number, flip: boolean) => {
        for (const poly of groupOutlines(closed)) {
          // earcut handles holes robustly (bridged rings break simple ear clipping)
          const contour = poly.outer.map((p) => new Vector2(p[0], p[1]));
          const holes = poly.holes.map((hole) => hole.map((p) => new Vector2(p[0], p[1])));
          const tris = ShapeUtils.triangulateShape(contour, holes);
          const base = positions.length / 3;
          // (triangulateShape may drop duplicated end points: use its arrays for the vertices)
          for (const p of [...contour, ...holes.flat()]) add([p.x, p.y, z + 0]);
          for (const t of tris) {
            const v = [base + t[0], base + t[1], base + t[2]];
            faces.push({ verts: flip ? [v[0], v[2], v[1]] : v, material: poly.material });
          }
        }
      };
      const h = cu.extrude;
      const frontBack = cu.fill_mode === 'BOTH' || cu.fill_mode === 'FULL';
      if (frontBack || cu.fill_mode === 'FRONT') fillAt(h, false);
      if (frontBack || cu.fill_mode === 'BACK') fillAt(-h, true);
    }
  }
  for (const s of sampled) {
    const n = s.points.length;
    if (n < 2) continue;
    if (!hasGeometry) {
      curves.push({ points: new Float32Array(s.points.flat()), cyclic: s.cyclic });
      continue;
    }
    const { N, B } = frames(s.points, s.cyclic, is2D);
    const ring = profile ? 0 : cu.bevel_depth > 0 ? Math.max(4, (cu.bevel_resolution + 2) * 2) : 0;
    const rows: number[][] = [];
    // arc-length parameter for the taper
    const along: number[] = [0];
    for (let i = 1; i < n; i++) along.push(along[i - 1] + Math.hypot(s.points[i][0] - s.points[i - 1][0], s.points[i][1] - s.points[i - 1][1], s.points[i][2] - s.points[i - 1][2]));
    const total = along[n - 1] || 1;
    for (let i = 0; i < n; i++) {
      const p = s.points[i],
        r = s.radius[i] * (shape.taper ? Math.max(0, shape.taper(along[i] / total)) : 1),
        tilt = s.tilt[i];
      const ct = Math.cos(tilt),
        st = Math.sin(tilt);
      const nn: Vec3 = [N[i][0] * ct + B[i][0] * st, N[i][1] * ct + B[i][1] * st, N[i][2] * ct + B[i][2] * st];
      const bb: Vec3 = [B[i][0] * ct - N[i][0] * st, B[i][1] * ct - N[i][1] * st, B[i][2] * ct - N[i][2] * st];
      const row: number[] = [];
      if (profile) {
        // custom cross-section from the bevel object
        for (const [px, py] of profile) row.push(add([p[0] + (bb[0] * px + nn[0] * py) * r, p[1] + (bb[1] * px + nn[1] * py) * r, p[2] + (bb[2] * px + nn[2] * py) * r]));
      } else if (ring) {
        // tube profile (optionally stretched by extrude)
        for (let k = 0; k < ring; k++) {
          const a = (k / ring) * Math.PI * 2;
          const ex = Math.sin(a) >= 0 ? cu.extrude : -cu.extrude;
          const d = cu.bevel_depth * r;
          row.push(add([p[0] + (bb[0] * Math.cos(a) + nn[0] * Math.sin(a)) * d + nn[0] * ex, p[1] + (bb[1] * Math.cos(a) + nn[1] * Math.sin(a)) * d + nn[1] * ex, p[2] + (bb[2] * Math.cos(a) + nn[2] * Math.sin(a)) * d + nn[2] * ex]));
        }
      } else {
        const e = cu.extrude;
        row.push(add([p[0] - nn[0] * e, p[1] - nn[1] * e, p[2] - nn[2] * e]), add([p[0] + nn[0] * e, p[1] + nn[1] * e, p[2] + nn[2] * e]));
      }
      rows.push(row);
    }
    const segs = s.cyclic ? n : n - 1;
    const rl = rows[0].length;
    const wrap = ring > 0 || (!!profile && !!shape.profileClosed);
    for (let i = 0; i < segs; i++) {
      const a = rows[i],
        b = rows[(i + 1) % n];
      const cols = wrap ? rl : rl - 1;
      for (let k = 0; k < cols; k++) {
        const k2 = (k + 1) % rl;
        faces.push({
          verts: [a[k], b[k], b[k2], a[k2]],
          uvs: [i / segs, k / cols, (i + 1) / segs, k / cols, (i + 1) / segs, (k + 1) / cols, i / segs, (k + 1) / cols],
          smooth: s.smooth,
          material: s.material,
        });
      }
    }
    if ((ring || (profile && shape.profileClosed)) && !s.cyclic && cu.use_fill_caps) {
      faces.push({ verts: [...rows[0]].reverse(), material: s.material });
      faces.push({ verts: [...rows[n - 1]], material: s.material });
    }
  }
  const built = buildMesh(positions, faces);
  return { ...built, curves: curves.length ? curves : undefined };
}

interface Outline {
  outer: Vec3[];
  holes: Vec3[][];
  material: number;
}

function area2(p: Vec3[]) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return a / 2;
}

function inside(pt: Vec3, poly: Vec3[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (a[1] > pt[1] !== b[1] > pt[1] && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

/** Even-odd nesting of closed outlines into outer shapes with holes. */
function groupOutlines(closed: SampledSpline[]): Outline[] {
  const items = closed.map((s) => ({ pts: s.points, area: Math.abs(area2(s.points)), material: s.material }));
  items.sort((a, b) => b.area - a.area);
  const depth = items.map((it, i) => items.slice(0, i).filter((o) => inside(it.pts[0], o.pts)).length);
  const out: Outline[] = [];
  items.forEach((it, i) => {
    if (depth[i] % 2 === 0) {
      const outer = area2(it.pts) < 0 ? [...it.pts].reverse() : it.pts;
      out.push({ outer, holes: [], material: it.material });
    }
  });
  items.forEach((it, i) => {
    if (depth[i] % 2 === 1) {
      const host = out.filter((o) => inside(it.pts[0], o.outer)).sort((a, b) => Math.abs(area2(a.outer)) - Math.abs(area2(b.outer)))[0];
      if (host) host.holes.push(area2(it.pts) > 0 ? [...it.pts].reverse() : it.pts);
    }
  });
  return out;
}

