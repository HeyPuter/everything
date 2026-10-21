// Curve evaluation: Bézier/poly/NURBS splines → polylines → wire, tube (bevel),
// extruded ribbon, or filled 2D shapes.
import type { CurveData, Spline, Vec3 } from '../data/types';
import type { EvalMesh } from './types';
import { buildMesh, type PolyFace } from '../mesh/mesh';
import { ShapeUtils, Vector2 } from 'three';
import { textToCurves } from './text';
import { knotSpec, basisAt, samples as nurbsSamples } from '../surface/nurbs';

export interface SampledSpline {
  points: Vec3[];
  /** exact unit tangents at the points (Bézier splines) */
  tangents?: Vec3[];
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
  let tans: Vec3[] | undefined;
  if (s.type === 'BEZIER') {
    const bp = s.bezier_points,
      n = bp.length;
    const segs = s.use_cyclic_u ? n : n - 1;
    tans = [];
    const tangent = (a: (typeof bp)[number], b: (typeof bp)[number], t: number): Vec3 => {
      const m = 1 - t;
      const d = [0, 1, 2].map((k) => 3 * m * m * (a.handle_right[k] - a.co[k]) + 6 * m * t * (b.handle_left[k] - a.handle_right[k]) + 3 * t * t * (b.co[k] - b.handle_left[k])) as Vec3;
      return len(d) > 1e-9 ? norm(d) : norm(sub(b.co as Vec3, a.co as Vec3));
    };
    for (let i = 0; i < segs; i++) {
      const a = bp[i],
        b = bp[(i + 1) % n];
      for (let k = 0; k < res; k++) {
        const t = k / res;
        pts.push([0, 1, 2].map((ax) => bez(a.co[ax], a.handle_right[ax], b.handle_left[ax], b.co[ax], t)) as Vec3);
        rad.push(a.radius + (b.radius - a.radius) * t);
        tilt.push(a.tilt + (b.tilt - a.tilt) * t);
        tans.push(tangent(a, b, t));
      }
    }
    if (!s.use_cyclic_u && n) {
      pts.push([...bp[n - 1].co] as Vec3);
      rad.push(bp[n - 1].radius);
      tilt.push(bp[n - 1].tilt);
      if (n > 1) tans.push(tangent(bp[n - 2], bp[n - 1], 1));
    }
    if (tans.length !== pts.length) tans = undefined;
  } else if (s.type === 'POLY') {
    for (const p of s.points) {
      pts.push([p.co[0], p.co[1], p.co[2]]);
      rad.push(p.radius);
      tilt.push(p.tilt);
    }
  } else {
    // NURBS: rational B-spline over the spline's knot vector (uniform, endpoint or Bézier knots),
    // `resolution` points per knot span
    const cps = s.points,
      n = cps.length;
    if (n >= 2) {
      const cyclic = s.use_cyclic_u;
      const ks = knotSpec({ n, order: s.order_u || 4, cyclic, endpoint: !!s.use_endpoint_u, bezier: !!s.use_bezier_u });
      let spans = 0;
      for (let i = ks.order - 1; i < ks.ctrl.length; i++) if (ks.knots[i + 1] > ks.knots[i]) spans++;
      const count = res * Math.max(1, spans) + (cyclic ? 0 : 1);
      const tmp = new Float64Array(ks.order);
      for (const t of nurbsSamples(ks, count, cyclic)) {
        const span = basisAt(ks, t, tmp);
        let x = 0,
          y = 0,
          z = 0,
          w = 0,
          r = 0,
          tl = 0;
        for (let k = 0; k < ks.order; k++) {
          const ci = span - ks.order + 1 + k;
          if (ci < 0 || ci >= ks.ctrl.length || !tmp[k]) continue;
          const c = cps[ks.ctrl[ci]];
          const b = tmp[k] * (c.co[3] || 1);
          x += c.co[0] * b;
          y += c.co[1] * b;
          z += c.co[2] * b;
          r += c.radius * b;
          tl += c.tilt * b;
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
  return { points: pts, tangents: tans, radius: rad, tilt, cyclic: s.use_cyclic_u, material: s.material_index, smooth: s.use_smooth };
}

/**
 * Frames along a polyline: parallel transport (least twist), Z up for flat curves, or following the
 * curvature (TANGENT). `smooth` iterations even out the twist.
 */
export function frames(points: Vec3[], cyclic: boolean, planarZ: boolean, twist: 'MINIMUM' | 'Z_UP' | 'TANGENT' = 'MINIMUM', smooth = 0, tangents?: Vec3[]) {
  if (!planarZ && twist !== 'MINIMUM' && points.length > 1) return twistFrames(points, cyclic, twist, smooth, tangents);
  const f = transportFrames(points, cyclic, planarZ, tangents);
  return smooth > 0 && !planarZ ? smoothFrames(f, cyclic, smooth) : f;
}

function twistFrames(points: Vec3[], cyclic: boolean, twist: 'Z_UP' | 'TANGENT', smooth: number, tangents?: Vec3[]) {
  const base = transportFrames(points, cyclic, false, tangents);
  const n = points.length;
  const N: Vec3[] = [],
    B: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const T = base.T[i];
    let up: Vec3 | null = null;
    if (twist === 'Z_UP') up = Math.abs(T[2]) < 0.999 ? [0, 0, 1] : null;
    else {
      // the direction the curve turns to (second difference), where it bends
      const prev = points[cyclic ? (i - 1 + n) % n : Math.max(0, i - 1)],
        next = points[cyclic ? (i + 1) % n : Math.min(n - 1, i + 1)];
      const k = sub(sub(next, points[i]), sub(points[i], prev));
      const kn = sub(k, [T[0] * dot(k, T), T[1] * dot(k, T), T[2] * dot(k, T)]);
      if (len(kn) > 1e-9) up = norm(kn);
    }
    if (!up) {
      N.push(base.N[i]);
      B.push(base.B[i]);
      continue;
    }
    const b = norm(cross(T, up));
    N.push(norm(cross(b, T)));
    B.push(b);
  }
  const f = { T: base.T, N, B };
  return smooth > 0 ? smoothFrames(f, cyclic, smooth) : f;
}

/** Even out the normals along the curve (neighbour averages kept perpendicular to the tangent). */
function smoothFrames(f: { T: Vec3[]; N: Vec3[]; B: Vec3[] }, cyclic: boolean, iterations: number) {
  let N = f.N;
  const n = N.length;
  for (let it = 0; it < Math.round(iterations); it++) {
    N = N.map((v, i) => {
      if (!cyclic && (i === 0 || i === n - 1)) return v;
      const a = N[(i - 1 + n) % n],
        c = N[(i + 1) % n];
      const m: Vec3 = [(a[0] + 2 * v[0] + c[0]) / 4, (a[1] + 2 * v[1] + c[1]) / 4, (a[2] + 2 * v[2] + c[2]) / 4];
      const T = f.T[i];
      return norm(sub(m, [T[0] * dot(m, T), T[1] * dot(m, T), T[2] * dot(m, T)]));
    });
  }
  const B = N.map((v, i) => norm(cross(f.T[i], v)));
  return { T: f.T, N, B };
}

function transportFrames(points: Vec3[], cyclic: boolean, planarZ: boolean, tangents?: Vec3[]) {
  const n = points.length;
  const T: Vec3[] = [],
    N: Vec3[] = [],
    B: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const prev = points[cyclic ? (i - 1 + n) % n : Math.max(0, i - 1)],
      next = points[cyclic ? (i + 1) % n : Math.min(n - 1, i + 1)];
    T.push(tangents && tangents.length === n ? tangents[i] : norm(sub(next, prev)));
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
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
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
  /** resolution used instead of every spline's own (render resolution) */
  resolution?: number;
}

/** The part of a sampled spline between two factors (0..1) along it, by sample index, control segment or length. */
export function trimSampled(s: SampledSpline, start: number, end: number, mapStart: string, mapEnd: string, segments: number): SampledSpline {
  const n = s.points.length;
  if (n < 2 || (start <= 0 && end >= 1) || s.cyclic) return s;
  const lens = [0];
  for (let i = 1; i < n; i++) lens.push(lens[i - 1] + len(sub(s.points[i], s.points[i - 1])));
  const total = lens[n - 1] || 1;
  // the sample position (fractional index) for a factor under a mapping
  const at = (f: number, mapping: string) => {
    f = Math.max(0, Math.min(1, f));
    if (mapping === 'SPLINE') {
      const d = f * total;
      let i = 1;
      while (i < n - 1 && lens[i] < d) i++;
      return i - 1 + (d - lens[i - 1]) / (lens[i] - lens[i - 1] || 1);
    }
    if (mapping === 'SEGMENTS' && segments > 0) {
      // every control segment gets the same share of the factor, spread over its evaluated points
      const per = (n - 1) / segments;
      const seg = Math.min(segments - 1, Math.floor(f * segments));
      return seg * per + (f * segments - seg) * per;
    }
    return f * (n - 1);
  };
  const i0 = at(start, mapStart),
    i1 = Math.max(i0, at(end, mapEnd));
  const lerpAt = <T extends number | Vec3>(arr: T[], x: number): T => {
    const i = Math.min(n - 2, Math.floor(x)),
      k = x - i;
    const a = arr[i],
      b = arr[i + 1];
    if (typeof a === 'number') return (a + ((b as number) - a) * k) as T;
    return [0, 1, 2].map((c) => (a as Vec3)[c] + ((b as Vec3)[c] - (a as Vec3)[c]) * k) as T;
  };
  const idx: number[] = [i0];
  for (let i = Math.floor(i0) + 1; i < i1; i++) if (i > i0 + 1e-6) idx.push(i);
  if (i1 - idx[idx.length - 1] > 1e-6) idx.push(i1);
  // a cut moves the next evaluated point onto the cut position: it keeps that point's radius and tilt
  const cell = (x: number) => Math.min(n - 1, Math.ceil(x - 1e-9));
  return { ...s, points: idx.map((x) => lerpAt(s.points, x)), tangents: s.tangents ? idx.map((x) => norm(lerpAt(s.tangents!, x))) : undefined, radius: idx.map((x) => s.radius[cell(x)]), tilt: idx.map((x) => s.tilt[cell(x)]) };
}

export function curveToMesh(cu: CurveData, isText = false, shape: CurveShapeOptions = {}): EvalMesh {
  const splines = shape.splines ?? (isText ? textToCurves(cu) : cu.splines);
  const sampled = splines.map((s) => sampleSpline(shape.resolution ? { ...s, resolution_u: shape.resolution } : s, shape.resolution ?? cu.resolution_u));
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
  const fStart = cu.bevel_factor_start ?? 0,
    fEnd = cu.bevel_factor_end ?? 1;
  // 3D fill: the whole tube, or open parts of its profile (angles of the profile points)
  const fill3D = !is2D ? (cu.fill_mode as string) : 'FULL';
  const res = Math.max(0, cu.bevel_resolution);
  const partial = fill3D === 'HALF' || fill3D === 'BACK' || fill3D === 'FRONT';
  const angles: number[] = [];
  if (partial) {
    const count = fill3D === 'HALF' ? 2 * (res + 1) + 1 : res + 2;
    const span = fill3D === 'HALF' ? Math.PI : Math.PI / 2;
    const from = fill3D === 'FRONT' ? Math.PI : -Math.PI / 2;
    for (let k = 0; k < count; k++) angles.push(from - (span * k) / (count - 1));
  }
  for (let si = 0; si < sampled.length; si++) {
    const full = sampled[si];
    // the part of the spline the bevel covers
    const s = hasGeometry ? trimSampled(full, fStart, fEnd, cu.bevel_factor_mapping_start ?? 'RESOLUTION', cu.bevel_factor_mapping_end ?? 'RESOLUTION', splineSegments(splines[si])) : full;
    const n = s.points.length;
    if (n < 2) continue;
    if (!hasGeometry) {
      curves.push({ points: new Float32Array(s.points.flat()), cyclic: s.cyclic });
      continue;
    }
    const { N, B } = frames(s.points, s.cyclic, is2D, cu.twist_mode ?? 'MINIMUM', cu.twist_smooth ?? 0, s.tangents);
    const ring = profile ? 0 : cu.bevel_depth > 0 ? (partial ? angles.length : Math.max(4, (cu.bevel_resolution + 2) * 2)) : 0;
    const rows: number[][] = [];
    // arc-length parameter for the taper (over the whole spline, or the covered part with Map Taper)
    const along: number[] = [0];
    for (let i = 1; i < n; i++) along.push(along[i - 1] + Math.hypot(s.points[i][0] - s.points[i - 1][0], s.points[i][1] - s.points[i - 1][1], s.points[i][2] - s.points[i - 1][2]));
    const total = along[n - 1] || 1;
    let fullLen = 0;
    for (let i = 1; i < full.points.length; i++) fullLen += len(sub(full.points[i], full.points[i - 1]));
    const startLen = s === full || cu.use_map_taper ? 0 : Math.max(0, fStart) * fullLen;
    const taperAt = (i: number) => (cu.use_map_taper || s === full ? along[i] / total : (startLen + along[i]) / (fullLen || 1));
    const taperMode = cu.taper_radius_mode ?? 'OVERRIDE';
    for (let i = 0; i < n; i++) {
      const tp = shape.taper ? Math.max(0, shape.taper(taperAt(i))) : null;
      const p = s.points[i],
        r = tp === null ? s.radius[i] : taperMode === 'MULTIPLY' ? s.radius[i] * tp : taperMode === 'ADD' ? s.radius[i] + tp : tp,
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
          const a = partial ? angles[k] : (k / ring) * Math.PI * 2;
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
    const wrap = (ring > 0 && !partial) || (!!profile && !!shape.profileClosed);
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
    if (((ring && !partial) || (profile && shape.profileClosed)) && !s.cyclic && cu.use_fill_caps) {
      faces.push({ verts: [...rows[0]].reverse(), material: s.material });
      faces.push({ verts: [...rows[n - 1]], material: s.material });
    }
  }
  const built = buildMesh(positions, faces);
  return { ...built, curves: curves.length ? curves : undefined };
}

/** Control segments of a spline (for the Segments bevel factor mapping). */
function splineSegments(s: Spline): number {
  const n = s.type === 'BEZIER' ? s.bezier_points.length : s.points.length;
  return Math.max(1, s.use_cyclic_u ? n : n - 1);
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

