// NURBS surfaces: knot vectors, rational B-spline evaluation and tessellation of a control point grid
// (U × V points, U varying fastest) into a quad mesh. Pure functions (unit tested).
import type { CurveData, Spline, SplinePoint } from '../data/types';
import type { EvalMesh } from '../eval/types';
import { buildMesh, type PolyFace } from '../mesh/mesh';

/** Parameter direction of a surface spline. */
export interface DirSpec {
  /** control point count along the direction */
  n: number;
  order: number;
  cyclic: boolean;
  endpoint: boolean;
  bezier: boolean;
  resolution: number;
}

/** Control point indices (wrapping for closed directions), knot vector and parameter range of a direction. */
export interface KnotSpec {
  ctrl: number[];
  knots: number[];
  order: number;
  t0: number;
  t1: number;
}

/** Point counts of a (surface) spline: U is the fast index of `points`. */
export function gridSize(sp: Spline): { u: number; v: number } {
  const u = Math.max(1, sp.point_count_u ?? sp.points.length);
  const v = Math.max(1, sp.point_count_v ?? Math.max(1, Math.floor(sp.points.length / u)));
  return { u, v };
}

export function dirSpecs(sp: Spline, cu?: Pick<CurveData, 'resolution_u' | 'resolution_v'>): { u: DirSpec; v: DirSpec } {
  const { u, v } = gridSize(sp);
  return {
    u: { n: u, order: sp.order_u || 4, cyclic: !!sp.use_cyclic_u, endpoint: !!sp.use_endpoint_u, bezier: !!sp.use_bezier_u, resolution: Math.max(1, sp.resolution_u || cu?.resolution_u || 4) },
    v: { n: v, order: sp.order_v || 4, cyclic: !!sp.use_cyclic_v, endpoint: !!sp.use_endpoint_v, bezier: !!sp.use_bezier_v, resolution: Math.max(1, sp.resolution_v || cu?.resolution_v || 4) },
  };
}

/** Clamped knots over m control points: `order` equal knots at both ends. */
function clamped(m: number, order: number): number[] {
  const k: number[] = [];
  for (let i = 0; i < m + order; i++) k.push(i < order ? 0 : i >= m ? m - order + 1 : i - order + 1);
  return k;
}

/** Clamped knots whose interior knots repeat order-1 times (a chain of Bézier segments). */
function bezierClamped(m: number, order: number): number[] {
  const k = new Array(order).fill(0);
  let v = 0;
  while (k.length < m) {
    v++;
    for (let r = 0; r < order - 1; r++) k.push(v);
  }
  k.length = m;
  const last = k[m - 1] + 1;
  for (let r = 0; r < order; r++) k.push(last);
  return k;
}

/**
 * Knot vector of one direction. Open: uniform (the curve stays inside the polygon), Endpoint (clamped,
 * touching the end points) or Bézier (segments through every order-1-th point). Closed: periodic,
 * Endpoint (clamped through the first point, closing back to it) or Bézier (closing segments).
 */
export function knotSpec(d: Pick<DirSpec, 'n' | 'order' | 'cyclic' | 'endpoint' | 'bezier'>): KnotSpec {
  const n = d.n;
  const order = Math.max(2, Math.min(d.order, n + (d.cyclic ? 1 : 0)));
  const idx = (m: number) => Array.from({ length: m }, (_, i) => i % n);
  let ctrl: number[], knots: number[];
  if (d.cyclic && (d.bezier || d.endpoint)) {
    ctrl = idx(n + 1);
    knots = d.bezier ? bezierClamped(n + 1, order) : clamped(n + 1, order);
  } else if (d.cyclic) {
    ctrl = idx(n + order - 1);
    knots = Array.from({ length: ctrl.length + order }, (_, i) => i);
  } else if (d.bezier) {
    ctrl = idx(n);
    knots = bezierClamped(n, order);
  } else if (d.endpoint) {
    ctrl = idx(n);
    knots = clamped(n, order);
  } else {
    ctrl = idx(n);
    knots = Array.from({ length: n + order }, (_, i) => i);
  }
  return { ctrl, knots, order, t0: knots[order - 1], t1: knots[ctrl.length] };
}

/**
 * Non-zero basis functions at t: fills `out` (order values) for control indices span-order+1 … span
 * and returns span.
 */
export function basisAt(ks: KnotSpec, t: number, out: Float64Array): number {
  const { knots, order } = ks;
  const m = ks.ctrl.length;
  // the span: knots[span] <= t < knots[span + 1], within the valid range
  let span = order - 1;
  while (span < m - 1 && t >= knots[span + 1]) span++;
  out.fill(0);
  out[0] = 1;
  const left = new Float64Array(order),
    right = new Float64Array(order);
  for (let j = 1; j < order; j++) {
    left[j] = t - knots[span + 1 - j];
    right[j] = knots[span + j] - t;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const den = right[r + 1] + left[j - r];
      const tmp = den !== 0 ? out[r] / den : 0;
      out[r] = saved + right[r + 1] * tmp;
      saved = left[j - r] * tmp;
    }
    out[j] = saved;
  }
  return span;
}

/** Sample parameters of a direction: `count` values over the valid range (closed directions skip the end). */
export function samples(ks: KnotSpec, count: number, cyclic: boolean): number[] {
  const out: number[] = [];
  const span = ks.t1 - ks.t0;
  for (let k = 0; k < count; k++) out.push(ks.t0 + (cyclic ? (span * k) / count : count > 1 ? (span * k) / (count - 1) : 0));
  return out;
}

/** Number of evaluated rows along a direction of a surface (resolution per control point). */
export const surfaceSamples = (d: DirSpec) => Math.max(2, d.resolution * d.n);

/** Basis weights per sample: control index list + weights (rational weights applied later). */
function sampleBasis(ks: KnotSpec, ts: number[]) {
  const tmp = new Float64Array(ks.order);
  return ts.map((t) => {
    const span = basisAt(ks, t, tmp);
    const ids: number[] = [],
      ws: number[] = [];
    for (let r = 0; r < ks.order; r++) {
      const ci = span - ks.order + 1 + r;
      if (ci < 0 || ci >= ks.ctrl.length || !tmp[r]) continue;
      ids.push(ks.ctrl[ci]);
      ws.push(tmp[r]);
    }
    return { ids, ws };
  });
}

/** Evaluate a 1-row spline (a NURBS curve) into polyline points (count = resolution × segments). */
export function evaluateRow(points: SplinePoint[], d: DirSpec): [number, number, number][] {
  if (points.length < 2) return points.map((p) => [p.co[0], p.co[1], p.co[2]]);
  const ks = knotSpec({ ...d, n: points.length });
  const count = Math.max(2, d.resolution * (d.cyclic ? points.length : points.length - 1));
  return sampleBasis(ks, samples(ks, count, d.cyclic)).map(({ ids, ws }) => {
    let x = 0,
      y = 0,
      z = 0,
      w = 0;
    ids.forEach((i, k) => {
      const c = points[i].co,
        b = ws[k] * (c[3] || 1);
      x += c[0] * b;
      y += c[1] * b;
      z += c[2] * b;
      w += b;
    });
    return w > 0 ? [x / w, y / w, z / w] : [0, 0, 0];
  });
}

export interface SurfaceGrid {
  /** xyz per evaluated vertex, row-major: vertex (iu, iv) at iu * nv + iv */
  positions: Float32Array;
  nu: number;
  nv: number;
  cyclicU: boolean;
  cyclicV: boolean;
}

/** Evaluate a surface spline (V > 1) on its sample grid. */
export function evaluateGrid(sp: Spline, cu?: Pick<CurveData, 'resolution_u' | 'resolution_v'>, scale = 1): SurfaceGrid {
  const { u, v } = dirSpecs(sp, cu);
  const ku = knotSpec(u),
    kv = knotSpec(v);
  const nu = Math.max(2, Math.round(surfaceSamples(u) * scale)),
    nv = Math.max(2, Math.round(surfaceSamples(v) * scale));
  const bu = sampleBasis(ku, samples(ku, nu, u.cyclic)),
    bv = sampleBasis(kv, samples(kv, nv, v.cyclic));
  const P = sp.points;
  const out = new Float32Array(nu * nv * 3);
  for (let a = 0; a < nu; a++)
    for (let b = 0; b < nv; b++) {
      let x = 0,
        y = 0,
        z = 0,
        w = 0;
      const BU = bu[a],
        BV = bv[b];
      for (let j = 0; j < BV.ids.length; j++)
        for (let i = 0; i < BU.ids.length; i++) {
          const c = P[BV.ids[j] * u.n + BU.ids[i]]?.co;
          if (!c) continue;
          const f = BU.ws[i] * BV.ws[j] * (c[3] || 1);
          x += c[0] * f;
          y += c[1] * f;
          z += c[2] * f;
          w += f;
        }
      const o = (a * nv + b) * 3;
      if (w > 0) {
        out[o] = x / w;
        out[o + 1] = y / w;
        out[o + 2] = z / w;
      }
    }
  return { positions: out, nu, nv, cyclicU: u.cyclic, cyclicV: v.cyclic };
}

/** Quad faces of an evaluated grid (closed directions wrap around; the wrapping column comes first). */
export function gridFaces(g: Pick<SurfaceGrid, 'nu' | 'nv' | 'cyclicU' | 'cyclicV'>, base = 0): number[][] {
  const { nu, nv } = g;
  const id = (a: number, b: number) => base + a * nv + b;
  const us = Array.from({ length: g.cyclicU ? nu : nu - 1 }, (_, i) => i);
  const vs = g.cyclicV ? [nv - 1, ...Array.from({ length: nv - 1 }, (_, i) => i)] : Array.from({ length: nv - 1 }, (_, i) => i);
  const faces: number[][] = [];
  for (const a of us)
    for (const b of vs) {
      const a1 = (a + 1) % nu,
        b1 = (b + 1) % nv;
      faces.push([id(a, b1), id(a1, b1), id(a1, b), id(a, b)]);
    }
  return faces;
}

/** Tessellate every spline of surface curve data into one mesh (1-row splines become wire edges). */
export function surfaceToMesh(cu: CurveData, render = false): EvalMesh {
  const pos: number[] = [];
  const faces: PolyFace[] = [];
  const loose: number[] = [];
  const scale = render && cu.render_resolution_u ? Math.max(0.01, cu.render_resolution_u / Math.max(1, cu.resolution_u || 1)) : 1;
  for (const sp of cu.splines) {
    if (sp.type !== 'NURBS' || !sp.points.length) continue;
    const { v } = gridSize(sp);
    const base = pos.length / 3;
    if (v <= 1) {
      const row = evaluateRow(sp.points, dirSpecs(sp, cu).u);
      row.forEach((p) => pos.push(p[0], p[1], p[2]));
      for (let i = 0; i + 1 < row.length; i++) loose.push(base + i, base + i + 1);
      if (sp.use_cyclic_u && row.length > 2) loose.push(base + row.length - 1, base);
      continue;
    }
    const g = evaluateGrid(sp, cu, scale);
    for (let i = 0; i < g.positions.length; i++) pos.push(g.positions[i]);
    for (const f of gridFaces(g, base)) {
      // UVs follow the sample grid
      const uv: number[] = [];
      for (const vi of f) {
        const k = vi - base;
        const a = Math.floor(k / g.nv),
          b = k % g.nv;
        uv.push(b / Math.max(1, g.cyclicV ? g.nv : g.nv - 1), a / Math.max(1, g.cyclicU ? g.nu : g.nu - 1));
      }
      faces.push({ verts: f, uvs: uv, smooth: sp.use_smooth, material: sp.material_index ?? 0 });
    }
  }
  const arr = buildMesh(pos, faces);
  const m: EvalMesh = { ...arr };
  if (loose.length) m.looseEdges = Uint32Array.from(loose);
  return m;
}

// ---------------------------------------------------------------------------
// primitives (control points in object space, size 1)

const W = Math.SQRT1_2;
type P4 = [number, number, number, number];
const pt = (co: P4): SplinePoint => ({ co, radius: 1, tilt: 0 });

/** The 8 control points of a unit NURBS circle in XY (start at -Y, counter-clockwise seen from -Z order). */
export function circlePoints(r = 1, z = 0): P4[] {
  const xy: [number, number, number][] = [
    [0, -1, 1],
    [-1, -1, W],
    [-1, 0, 1],
    [-1, 1, W],
    [0, 1, 1],
    [1, 1, W],
    [1, 0, 1],
    [1, -1, W],
  ];
  return xy.map(([x, y, w]) => [x * r, y * r, z, w]);
}

export type SurfacePrimitive = 'CURVE' | 'CIRCLE' | 'SURFACE' | 'CYLINDER' | 'SPHERE' | 'TORUS';

function spline(points: P4[], u: number, v: number, o: Partial<Spline>): Spline {
  return {
    type: 'NURBS',
    bezier_points: [],
    points: points.map(pt),
    use_cyclic_u: false,
    use_cyclic_v: false,
    resolution_u: 4,
    resolution_v: 4,
    order_u: 4,
    order_v: 4,
    point_count_u: u,
    point_count_v: v,
    use_smooth: true,
    material_index: 0,
    ...o,
  };
}

/** Control grid of a surface primitive of unit size (radius 1). */
export function surfacePrimitive(kind: SurfacePrimitive): Spline {
  switch (kind) {
    case 'CURVE':
      return spline(
        [
          [-1.5, 0, 0, 1],
          [-1, 1, 0, 1],
          [1, 1, 0, 1],
          [1.5, 0, 0, 1],
        ],
        4,
        1,
        { order_v: 0, resolution_v: 4 },
      );
    case 'CIRCLE':
      return spline(circlePoints(), 8, 1, { order_u: 3, order_v: 0, use_cyclic_u: true, use_endpoint_u: true, use_bezier_u: true });
    case 'SURFACE': {
      const pts: P4[] = [];
      for (const x of [-1.5, -0.5, 0.5, 1.5]) for (const y of [-1.5, -0.5, 0.5, 1.5]) pts.push([x, y, Math.abs(x) < 1 && Math.abs(y) < 1 ? 1 : 0, 1]);
      return spline(pts, 4, 4, {});
    }
    case 'CYLINDER':
      return spline([...circlePoints(1, -1), ...circlePoints(1, 1)], 8, 2, { order_u: 3, order_v: 2, use_cyclic_u: true, use_endpoint_u: true, use_bezier_u: true });
    case 'SPHERE':
      // a half circle profile (radial distance, height) revolved around Z
      return spline(revolve([[0, -1, 1], [1, -1, W], [1, 0, 1], [1, 1, W], [0, 1, 1]]), 5, 8, { order_u: 3, order_v: 3, use_cyclic_v: true, use_endpoint_u: true, use_endpoint_v: true, use_bezier_u: true, use_bezier_v: true });
    case 'TORUS':
      // a circle of radius 0.25 at distance 0.75 revolved around Z
      return spline(
        revolve([[0.75, -0.25, 1], [1, -0.25, W], [1, 0, 1], [1, 0.25, W], [0.75, 0.25, 1], [0.5, 0.25, W], [0.5, 0, 1], [0.5, -0.25, W]]),
        8,
        8,
        { order_u: 3, order_v: 3, use_cyclic_u: true, use_cyclic_v: true, use_endpoint_u: true, use_endpoint_v: true, use_bezier_u: true, use_bezier_v: true },
      );
  }
}

/** Directions (and weights) of the 8 columns of a revolution around Z, starting at -X. */
const REVOLVE_DIRS: [number, number, number][] = [
  [-1, 0, 1],
  [-1, -1, W],
  [0, -1, 1],
  [1, -1, W],
  [1, 0, 1],
  [1, 1, W],
  [0, 1, 1],
  [-1, 1, W],
];

/** Control points of a profile (radial distance, height, weight) revolved around Z: U along the profile, V around. */
export function revolve(profile: [number, number, number][]): P4[] {
  const pts: P4[] = [];
  for (const [dx, dy, cw] of REVOLVE_DIRS) for (const [r, z, pw] of profile) pts.push([fix(r * dx), fix(r * dy), z, pw * cw]);
  return pts;
}
const fix = (x: number) => (Object.is(x, -0) ? 0 : x);
