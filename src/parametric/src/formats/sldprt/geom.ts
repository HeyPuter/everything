// Evaluation of Parasolid curves and surfaces in their own parametrizations,
// with closest-point projection. The STEP writer uses it where a node has no
// exact STEP counterpart: intersection curves are refined onto both of their
// surfaces, curves in a surface's parameter space are sampled through it, and
// rolling-ball blends are rebuilt from their spine and supports.

import type { Vec3 } from '../../math/vec';
import { add, cross, dist, dot, len, normalize, scale, sub } from '../../math/vec';
import type { XtNode, XtValue } from './xt';

export class Graph {
  constructor(readonly nodes: Map<number, XtNode>) {}
  get(id: XtValue | undefined): XtNode | undefined {
    return typeof id === 'number' ? this.nodes.get(id) : undefined;
  }
  ref(n: XtNode, field: string): XtNode | undefined {
    return this.get(n.f[field]);
  }
  refs(n: XtNode, field: string): (XtNode | undefined)[] {
    const v = n.f[field];
    return Array.isArray(v) ? v.map((x) => this.get(x as XtValue)) : [this.get(v)];
  }
}

export const vec = (n: XtNode, field: string): Vec3 => {
  const v = n.f[field];
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new GeomError(`${n.name} has no ${field}`);
  return v as Vec3;
};
export const num = (n: XtNode, field: string): number => {
  const v = n.f[field];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new GeomError(`${n.name} has no ${field}`);
  return v;
};
export const sign = (n: XtNode | undefined) => (n?.f.sense === '-' ? -1 : 1);

export class GeomError extends Error {}

// ---- NURBS ----

export interface Nurbs {
  degree: number;
  /** Expanded knot vector. */
  knots: number[];
  /** Control points, homogeneous (w·x, w·y, ..., w) when rational. */
  ctrl: number[][];
  rational: boolean;
}

function knotVector(g: Graph, owner: XtNode, knotsField: string, multField: string): number[] {
  const ks = g.ref(owner, knotsField)?.f.knots as number[] | undefined;
  const ms = g.ref(owner, multField)?.f.mult as number[] | undefined;
  if (!ks || !ms || ks.length !== ms.length) throw new GeomError('Bad B-spline knots');
  const out: number[] = [];
  ks.forEach((k, i) => { for (let j = 0; j < ms[i]; j++) out.push(k); });
  return out;
}

export function nurbsCurve(g: Graph, bcurve: XtNode): Nurbs {
  const nc = g.ref(bcurve, 'nurbs');
  if (!nc) throw new GeomError('B-curve without data');
  const degree = num(nc, 'degree'), n = num(nc, 'n_vertices'), dim = num(nc, 'vertex_dim');
  const flat = g.ref(nc, 'bspline_vertices')?.f.vertices as number[] | undefined;
  if (!flat || flat.length < n * dim) throw new GeomError('Bad B-curve vertices');
  const ctrl = Array.from({ length: n }, (_, i) => flat.slice(i * dim, i * dim + dim));
  const knots = knotVector(g, nc, 'knots', 'knot_mult');
  if (knots.length !== n + degree + 1) throw new GeomError('Bad B-curve knot count');
  return { degree, knots, ctrl, rational: !!nc.f.rational };
}

export interface NurbsSurf {
  du: number; dv: number;
  uk: number[]; vk: number[];
  nu: number; nv: number;
  /** ctrl[iu][iv] */
  ctrl: number[][][];
  rational: boolean;
}

export function nurbsSurface(g: Graph, bsurf: XtNode): NurbsSurf {
  const ns = g.ref(bsurf, 'nurbs');
  if (!ns) throw new GeomError('B-surface without data');
  const du = num(ns, 'u_degree'), dv = num(ns, 'v_degree');
  const nu = num(ns, 'n_u_vertices'), nv = num(ns, 'n_v_vertices'), dim = num(ns, 'vertex_dim');
  const flat = g.ref(ns, 'bspline_vertices')?.f.vertices as number[] | undefined;
  if (!flat || flat.length < nu * nv * dim) throw new GeomError('Bad B-surface vertices');
  // Stored with v varying fastest.
  const ctrl = Array.from({ length: nu }, (_, iu) => Array.from({ length: nv }, (_, iv) => flat.slice((iu * nv + iv) * dim, (iu * nv + iv) * dim + dim)));
  const uk = knotVector(g, ns, 'u_knots', 'u_knot_mult'), vk = knotVector(g, ns, 'v_knots', 'v_knot_mult');
  if (uk.length !== nu + du + 1 || vk.length !== nv + dv + 1) throw new GeomError('Bad B-surface knot count');
  return { du, dv, uk, vk, nu, nv, ctrl, rational: !!ns.f.rational };
}

function span(knots: number[], p: number, n: number, t: number): number {
  if (t >= knots[n]) return n - 1;
  if (t <= knots[p]) return p;
  let lo = p, hi = n;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t < knots[mid]) hi = mid; else lo = mid; }
  return lo;
}

/** Basis functions and their first derivatives at t (The NURBS Book A2.3). */
function basis(knots: number[], p: number, i: number, t: number): [number[], number[]] {
  const ndu = Array.from({ length: p + 1 }, () => new Array<number>(p + 1).fill(0));
  const left = new Array<number>(p + 1).fill(0), right = new Array<number>(p + 1).fill(0);
  ndu[0][0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = t - knots[i + 1 - j];
    right[j] = knots[i + j] - t;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      ndu[j][r] = right[r + 1] + left[j - r];
      const tmp = ndu[j][r] ? ndu[r][j - 1] / ndu[j][r] : 0;
      ndu[r][j] = saved + right[r + 1] * tmp;
      saved = left[j - r] * tmp;
    }
    ndu[j][j] = saved;
  }
  const N = Array.from({ length: p + 1 }, (_, j) => ndu[j][p]);
  const D = new Array<number>(p + 1).fill(0);
  if (p > 0) {
    for (let r = 0; r <= p; r++) {
      let d = 0;
      if (r >= 1) d += ndu[p][r - 1] ? ndu[r - 1][p - 1] / ndu[p][r - 1] : 0;
      if (r <= p - 1) d -= ndu[p][r] ? ndu[r][p - 1] / ndu[p][r] : 0;
      D[r] = d * p;
    }
  }
  return [N, D];
}

/** Point and first derivative of a NURBS curve, in its (non-homogeneous) dimension. */
export function nurbsCurveEval(c: Nurbs, t: number): [number[], number[]] {
  const n = c.ctrl.length, p = c.degree;
  const s = span(c.knots, p, n, t);
  const [N, D] = basis(c.knots, p, s, t);
  const dim = c.ctrl[0].length;
  const P = new Array<number>(dim).fill(0), dP = new Array<number>(dim).fill(0);
  for (let j = 0; j <= p; j++) {
    const cp = c.ctrl[s - p + j];
    for (let k = 0; k < dim; k++) { P[k] += N[j] * cp[k]; dP[k] += D[j] * cp[k]; }
  }
  if (!c.rational) return [P, dP];
  const w = P[dim - 1], dw = dP[dim - 1];
  const pt = P.slice(0, -1).map((x) => x / w);
  return [pt, dP.slice(0, -1).map((x, k) => (x - dw * pt[k]) / w)];
}

export function nurbsSurfEval(s: NurbsSurf, u: number, v: number): [Vec3, Vec3, Vec3] {
  const iu = span(s.uk, s.du, s.nu, u), iv = span(s.vk, s.dv, s.nv, v);
  const [Nu, Du] = basis(s.uk, s.du, iu, u), [Nv, Dv] = basis(s.vk, s.dv, iv, v);
  const dim = s.ctrl[0][0].length;
  const P = new Array<number>(dim).fill(0), Pu = new Array<number>(dim).fill(0), Pv = new Array<number>(dim).fill(0);
  for (let a = 0; a <= s.du; a++) {
    const row = s.ctrl[iu - s.du + a];
    for (let b = 0; b <= s.dv; b++) {
      const cp = row[iv - s.dv + b];
      const nn = Nu[a] * Nv[b], nu = Du[a] * Nv[b], nv = Nu[a] * Dv[b];
      for (let k = 0; k < dim; k++) { P[k] += nn * cp[k]; Pu[k] += nu * cp[k]; Pv[k] += nv * cp[k]; }
    }
  }
  if (!s.rational) return [P as Vec3, Pu as Vec3, Pv as Vec3];
  const w = P[3];
  const pt: Vec3 = [P[0] / w, P[1] / w, P[2] / w];
  const d = (D: number[]): Vec3 => [(D[0] - D[3] * pt[0]) / w, (D[1] - D[3] * pt[1]) / w, (D[2] - D[3] * pt[2]) / w];
  return [pt, d(Pu), d(Pv)];
}

// ---- curves ----

export interface Curve {
  eval(t: number): Vec3;
  /** Parameter range, or null when unbounded (lines). */
  range: [number, number] | null;
  period?: number;
  /** Parameter of the point on the curve closest to p. */
  param(p: Vec3, near?: number): number;
}

/** Curve parameter closest to p: the best of a coarse sampling (optionally
 *  of a cheaper approximation of the curve), refined by Gauss-Newton. */
function paramBySearch(c: { eval(t: number): Vec3 }, lo: number, hi: number, p: Vec3, samples = 64, coarse = c.eval): number {
  let best = lo, bd = Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = lo + ((hi - lo) * i) / samples;
    const d = dist(coarse(t), p);
    if (d < bd) { bd = d; best = t; }
  }
  let t = best;
  let P = c.eval(t);
  bd = dist(P, p);
  const h = (hi - lo) * 1e-7;
  for (let k = 0; k < 30; k++) {
    const D = scale(sub(c.eval(Math.min(hi, t + h)), c.eval(Math.max(lo, t - h))), 1 / (Math.min(hi, t + h) - Math.max(lo, t - h)));
    const dd = dot(D, D);
    if (!(dd > 1e-300)) break;
    let step = -dot(sub(P, p), D) / dd;
    // Damp until the distance does not grow.
    for (let j = 0; j < 30; j++, step /= 2) {
      const tn = Math.min(hi, Math.max(lo, t + step));
      const Pn = c.eval(tn), dn = dist(Pn, p);
      if (dn <= bd) {
        const done = Math.abs(tn - t) < 1e-14 * (1 + Math.abs(t)) + (hi - lo) * 1e-15;
        t = tn; P = Pn; bd = dn;
        if (done) return t;
        break;
      }
      if (j === 29) return t;
    }
  }
  return t;
}

/** A bounded curve whose ends meet behaves as periodic, so that a point at the
 *  closure has a parameter at either end. */
function closeUp(c: Curve): Curve {
  if (!c.range || c.period) return c;
  const [lo, hi] = c.range;
  const a = c.eval(lo), b = c.eval(hi);
  if (dist(a, b) > 1e-9 * Math.max(1, len(a))) return c;
  const P = hi - lo;
  const wrap = (t: number) => (t >= lo && t <= hi ? t : lo + (((t - lo) % P) + P) % P);
  return { eval: (t) => c.eval(wrap(t)), range: c.range, period: P, param: c.param };
}

export function makeCurve(g: Graph, n: XtNode): Curve {
  const c = makeOpenCurve(g, n);
  return n.name === 'TRIMMED_CURVE' ? c : closeUp(c);
}

function makeOpenCurve(g: Graph, n: XtNode): Curve {
  switch (n.name) {
    case 'LINE': {
      const p = vec(n, 'pvec'), d = normalize(vec(n, 'direction'));
      return { eval: (t) => add(p, scale(d, t)), range: null, param: (q) => dot(sub(q, p), d) };
    }
    case 'CIRCLE': case 'ELLIPSE': {
      const c = vec(n, 'centre'), nz = normalize(vec(n, 'normal')), x = normalize(vec(n, 'x_axis')), y = cross(nz, x);
      const r1 = n.name === 'CIRCLE' ? num(n, 'radius') : num(n, 'major_radius');
      const r2 = n.name === 'CIRCLE' ? r1 : num(n, 'minor_radius');
      return {
        eval: (t) => add(c, add(scale(x, r1 * Math.cos(t)), scale(y, r2 * Math.sin(t)))),
        range: [0, 2 * Math.PI], period: 2 * Math.PI,
        param: (q) => { const d = sub(q, c); const t = Math.atan2(dot(d, y) / r2, dot(d, x) / r1); return t < 0 ? t + 2 * Math.PI : t; },
      };
    }
    case 'B_CURVE': {
      const nc = nurbsCurve(g, n);
      const lo = nc.knots[nc.degree], hi = nc.knots[nc.ctrl.length];
      const ev = (t: number) => nurbsCurveEval(nc, t)[0] as Vec3;
      return { eval: ev, range: [lo, hi], param: (q) => paramBySearch({ eval: ev }, lo, hi, q, Math.max(64, nc.ctrl.length * 8)) };
    }
    case 'TRIMMED_CURVE': {
      const b = g.ref(n, 'basis_curve');
      if (!b) throw new GeomError('Trimmed curve without basis');
      const base = makeCurve(g, b);
      // A basis of sense '-' is run backwards, from parm_1 down to parm_2.
      let t1 = num(n, 'parm_1'), t2 = num(n, 'parm_2');
      if (base.period && t2 <= t1 && sign(b) > 0) t2 += base.period;
      if (t2 < t1) [t1, t2] = [t2, t1];
      return { eval: base.eval, range: [t1, t2], param: (q) => paramBySearch(base, t1, t2, q) };
    }
    case 'SP_CURVE': {
      const s = g.ref(n, 'surface'), b = g.ref(n, 'b_curve');
      if (!s || !b) throw new GeomError('SP-curve without data');
      const surf = makeSurface(g, s), nc = nurbsCurve(g, b);
      const lo = nc.knots[nc.degree], hi = nc.knots[nc.ctrl.length];
      const ev = (t: number) => { const [uv] = nurbsCurveEval(nc, t); return surf.eval(uv[0], uv[1]); };
      return { eval: ev, range: [lo, hi], param: (q) => paramBySearch({ eval: ev }, lo, hi, q, Math.max(64, nc.ctrl.length * 8)) };
    }
    case 'INTERSECTION': {
      const pts = intersectionPoints(g, n);
      const refine = intersectionRefiner(g, n, pts);
      // Piecewise linear in the chart, each evaluation pulled onto the true curve.
      const lin = (t: number): Vec3 => {
        const i = Math.max(0, Math.min(pts.length - 2, Math.floor(t)));
        const f = t - i;
        return add(scale(pts[i], 1 - f), scale(pts[i + 1], f));
      };
      const ev = (t: number) => refine(lin(t));
      return { eval: ev, range: [0, pts.length - 1], param: (q) => paramBySearch({ eval: ev }, 0, pts.length - 1, q, (pts.length - 1) * 8, lin) };
    }
  }
  throw new GeomError(`Unsupported curve ${n.name}`);
}

/** Pulls a point near an intersection curve onto it. A side may be a blend's
 *  boundary rather than a surface: there the curve is where the blend touches
 *  its support, found from the ball centre on the spine. */
function intersectionRefiner(g: Graph, n: XtNode, pts: Vec3[]): (q: Vec3) => Vec3 {
  const sides = g.refs(n, 'surface').map((s) => {
    if (!s) return null;
    if (s.name === 'BLEND_BOUND') {
      // The boundary's own side index is not reliable; take the support whose
      // contact line passes through the stored points.
      const blend = g.ref(s, 'blend');
      if (!blend) return null;
      const probe = pts[Math.floor(pts.length / 2)];
      let best: ((q: Vec3) => Vec3 | null) | null = null, bd = Infinity;
      for (const side of [0, 1]) {
        const f = blendContact(g, blend, side);
        const p = f(probe);
        if (p && dist(p, probe) < bd) { bd = dist(p, probe); best = f; }
      }
      return best ? { contact: best } : null;
    }
    try { return { surf: makeSurface(g, s) }; } catch { return null; }
  });
  const contact = sides.find((x) => x?.contact)?.contact;
  if (contact) return (q) => contact(q) ?? q;
  const surfs = sides.map((x) => x?.surf).filter((x): x is Surface => !!x);
  if (surfs.length === 2) return (q) => onBoth(surfs[0], surfs[1], q);
  if (surfs.length === 1) return (q) => surfs[0].project(q).p;
  return (q) => q;
}

/** Closest point to c on one of a blend's supports. A zero-radius blend
 *  support stands for its spine, a sharp edge the ball rolls along. */
export function supportContact(g: Graph, support: XtNode): ((c: Vec3) => Vec3) | null {
  if (support.name === 'BLENDED_EDGE') {
    const range = support.f.range as number[] | undefined;
    const sp = g.ref(support, 'spine');
    if (!sp || !range?.every((x) => Math.abs(x) < 1e-12)) return null;
    const spine = makeCurve(g, sp);
    return (c) => spine.eval(spine.param(c));
  }
  try {
    const s = makeSurface(g, support);
    return (c) => s.project(c).p;
  } catch {
    return null;
  }
}

/** Where a rolling-ball blend touches support `side`, for a point near that contact line. */
function blendContact(g: Graph, blend: XtNode, side: number): (q: Vec3) => Vec3 | null {
  const sp = g.ref(blend, 'spine'), support = g.refs(blend, 'surface')[side];
  if (!sp || !support) return () => null;
  let spine: Curve, touch: ((c: Vec3) => Vec3) | null;
  try { spine = makeCurve(g, sp); touch = supportContact(g, support); } catch { return () => null; }
  if (!touch) return () => null;
  return (q) => touch(spine.eval(spine.param(q)));
}

/** The stored polyline of an intersection curve, from its start to end limit. */
export function intersectionPoints(g: Graph, n: XtNode): Vec3[] {
  const chart = g.ref(n, 'chart');
  const hv = (chart?.f.hvec as Vec3[] | undefined)?.filter((p) => Array.isArray(p) && p.every(Number.isFinite)) ?? [];
  const pts = [...hv];
  const lim = (field: string) => (g.ref(n, field)?.f.hvec as Vec3[] | undefined)?.[0];
  const s = lim('start'), e = lim('end');
  if (s && (!pts.length || dist(s, pts[0]) > 1e-12)) pts.unshift(s);
  if (e && dist(e, pts[pts.length - 1]) > 1e-12) pts.push(e);
  if (pts.length < 2) throw new GeomError('Intersection curve without points');
  return pts;
}

// ---- surfaces ----

export interface Surface {
  name: string;
  eval(u: number, v: number): Vec3;
  /** Point and first partial derivatives. */
  d(u: number, v: number): [Vec3, Vec3, Vec3];
  /** Closest point: parameters, point and unit natural normal there. */
  project(p: Vec3, seed?: [number, number]): { u: number; v: number; p: Vec3; n: Vec3 };
}

const unit = (a: Vec3): Vec3 => { const l = len(a); return l > 1e-300 ? scale(a, 1 / l) : [0, 0, 0]; };

/** Gauss-Newton closest point on a parametric surface, from a seed. */
function newtonProject(d: Surface['d'], p: Vec3, u0: number, v0: number, clamp?: (u: number, v: number) => [number, number]) {
  let u = u0, v = v0;
  for (let k = 0; k < 40; k++) {
    const [S, Su, Sv] = d(u, v);
    const r = sub(S, p);
    const a = dot(Su, Su), b = dot(Su, Sv), c = dot(Sv, Sv);
    const ru = dot(r, Su), rv = dot(r, Sv);
    const det = a * c - b * b;
    if (!(Math.abs(det) > 1e-300)) break;
    let du = -(c * ru - b * rv) / det, dv = -(a * rv - b * ru) / det;
    // Keep steps bounded so a poor seed cannot fly off the patch.
    const stepLen = Math.hypot(du * Math.sqrt(a), dv * Math.sqrt(c));
    const lim = Math.max(len(r), 1e-12) * 2;
    if (stepLen > lim) { du *= lim / stepLen; dv *= lim / stepLen; }
    let nu = u + du, nv = v + dv;
    if (clamp) [nu, nv] = clamp(nu, nv);
    const moved = Math.abs(nu - u) + Math.abs(nv - v);
    u = nu; v = nv;
    if (moved < 1e-15 * (1 + Math.abs(u) + Math.abs(v))) break;
  }
  const [S, Su, Sv] = d(u, v);
  // Converged when the offset to p is normal to the surface.
  const r = sub(S, p), lr = len(r);
  const ok = lr < 1e-12 || (Math.abs(dot(r, Su)) <= 1e-8 * lr * len(Su) && Math.abs(dot(r, Sv)) <= 1e-8 * lr * len(Sv));
  return { u, v, p: S, n: unit(cross(Su, Sv)), ok };
}

/** Projection seeded from the nearest point of a parameter grid. */
function gridProject(d: Surface['d'], u0: number, u1: number, v0: number, v1: number, n = 16, clamp?: (u: number, v: number) => [number, number]) {
  let grid: { u: number; v: number; p: Vec3 }[] | null = null;
  return (p: Vec3, seed?: [number, number]) => {
    if (seed) {
      const r = newtonProject(d, p, seed[0], seed[1], clamp);
      if (r.ok) return r;
    }
    grid ??= Array.from({ length: (n + 1) * (n + 1) }, (_, k) => {
      const u = u0 + ((u1 - u0) * (k % (n + 1))) / n, v = v0 + ((v1 - v0) * Math.floor(k / (n + 1))) / n;
      return { u, v, p: d(u, v)[0] };
    });
    // Newton from the three nearest grid points.
    const near: { q: (typeof grid)[number]; d: number }[] = [];
    for (const q of grid) {
      const dq = dist(q.p, p);
      if (near.length < 3 || dq < near[2].d) {
        near.push({ q, d: dq });
        near.sort((a, b) => a.d - b.d);
        if (near.length > 3) near.pop();
      }
    }
    let best: ReturnType<typeof newtonProject> | null = null;
    for (const { q } of near) {
      const r = newtonProject(d, p, q.u, q.v, clamp);
      if (!best || dist(r.p, p) < dist(best.p, p)) best = r;
    }
    return best!;
  };
}

const frame = (n: XtNode, zField: string) => {
  const z = normalize(vec(n, zField)), x = normalize(vec(n, 'x_axis'));
  return { z, x, y: cross(z, x) };
};

export function makeSurface(g: Graph, n: XtNode): Surface {
  const name = n.name;
  switch (name) {
    case 'PLANE': {
      const p = vec(n, 'pvec'), { z, x, y } = frame(n, 'normal');
      const d = (u: number, v: number): [Vec3, Vec3, Vec3] => [add(p, add(scale(x, u), scale(y, v))), x, y];
      return {
        name, eval: (u, v) => d(u, v)[0], d,
        project: (q) => { const r = sub(q, p); const u = dot(r, x), v = dot(r, y); return { u, v, p: d(u, v)[0], n: z }; },
      };
    }
    case 'CYLINDER': case 'CONE': {
      const p = vec(n, 'pvec'), { z: a, x, y } = frame(n, 'axis'), r = num(n, 'radius');
      const tan = name === 'CONE' ? num(n, 'sin_half_angle') / num(n, 'cos_half_angle') : 0;
      const d = (u: number, v: number): [Vec3, Vec3, Vec3] => {
        const c = Math.cos(u), s = Math.sin(u), rad = r + v * tan;
        const dir = add(scale(x, c), scale(y, s));
        return [add(p, add(scale(dir, rad), scale(a, v))), scale(add(scale(x, -s), scale(y, c)), rad), add(scale(dir, tan), a)];
      };
      const proj = (q: Vec3, seed?: [number, number]) => {
        const w = sub(q, p);
        const u0 = Math.atan2(dot(w, y), dot(w, x));
        if (!tan) return { u: u0, v: dot(w, a), p: d(u0, dot(w, a))[0], n: add(scale(x, Math.cos(u0)), scale(y, Math.sin(u0))) };
        return newtonProject(d, q, u0, seed?.[1] ?? dot(w, a));
      };
      return { name, eval: (u, v) => d(u, v)[0], d, project: proj };
    }
    case 'SPHERE': {
      const c = vec(n, 'centre'), { z: a, x, y } = frame(n, 'axis'), r = num(n, 'radius');
      const d = (u: number, v: number): [Vec3, Vec3, Vec3] => {
        const cu = Math.cos(u), su = Math.sin(u), cv = Math.cos(v), sv = Math.sin(v);
        const dir = add(scale(x, cu), scale(y, su));
        return [
          add(c, scale(add(scale(dir, cv), scale(a, sv)), r)),
          scale(add(scale(x, -su), scale(y, cu)), r * cv),
          scale(add(scale(dir, -sv), scale(a, cv)), r),
        ];
      };
      return {
        name, eval: (u, v) => d(u, v)[0], d,
        project: (q) => {
          const w = sub(q, c);
          const u = Math.atan2(dot(w, y), dot(w, x)), v = Math.atan2(dot(w, a), Math.hypot(dot(w, x), dot(w, y)));
          const pt = d(u, v)[0];
          return { u, v, p: pt, n: unit(sub(pt, c)) };
        },
      };
    }
    case 'TORUS': {
      const c = vec(n, 'centre'), { z: a, x, y } = frame(n, 'axis');
      const R = num(n, 'major_radius'), r = num(n, 'minor_radius');
      const d = (u: number, v: number): [Vec3, Vec3, Vec3] => {
        const cu = Math.cos(u), su = Math.sin(u), cv = Math.cos(v), sv = Math.sin(v);
        const dir = add(scale(x, cu), scale(y, su));
        return [
          add(c, add(scale(dir, R + r * cv), scale(a, r * sv))),
          scale(add(scale(x, -su), scale(y, cu)), R + r * cv),
          add(scale(dir, -r * sv), scale(a, r * cv)),
        ];
      };
      return {
        name, eval: (u, v) => d(u, v)[0], d,
        project: (q) => {
          const w = sub(q, c);
          const u = Math.atan2(dot(w, y), dot(w, x));
          const dir = add(scale(x, Math.cos(u)), scale(y, Math.sin(u)));
          const v = Math.atan2(dot(w, a), dot(w, dir) - R);
          const pt = d(u, v)[0];
          return { u, v, p: pt, n: unit(sub(pt, add(c, scale(dir, R)))) };
        },
      };
    }
    case 'B_SURFACE': return nurbsSurfaceOf(nurbsSurface(g, n));
    case 'SWEPT_SURF': {
      const sec = g.ref(n, 'section');
      if (!sec) throw new GeomError('Swept surface without section');
      const c = makeCurve(g, sec), dir = vec(n, 'sweep');
      const h = 1e-7 * (c.range ? c.range[1] - c.range[0] : 1);
      const d = (u: number, v: number): [Vec3, Vec3, Vec3] => {
        const P = c.eval(u);
        return [add(P, scale(dir, v)), scale(sub(c.eval(u + h), c.eval(u - h)), 1 / (2 * h)), dir];
      };
      return {
        name, eval: (u, v) => d(u, v)[0], d,
        project: (q, seed) => {
          const du = normalize(dir);
          const u = seed?.[0] ?? c.param(sub(q, scale(du, dot(q, du))));
          const base = c.eval(u);
          return newtonProject(d, q, u, dot(sub(q, base), dir) / dot(dir, dir));
        },
      };
    }
    case 'SPUN_SURF': {
      const prof = g.ref(n, 'profile');
      if (!prof) throw new GeomError('Spun surface without profile');
      const c = makeCurve(g, prof), base = vec(n, 'base'), a = normalize(vec(n, 'axis'));
      const rot = (q: Vec3, ang: number): Vec3 => {
        const w = sub(q, base), along = scale(a, dot(w, a)), perp = sub(w, along);
        return add(base, add(along, add(scale(perp, Math.cos(ang)), scale(cross(a, perp), Math.sin(ang)))));
      };
      const h = 1e-7 * (c.range ? c.range[1] - c.range[0] : 1);
      // u: profile parameter, v: rotation angle.
      const d = (u: number, v: number): [Vec3, Vec3, Vec3] => {
        const P = rot(c.eval(u), v);
        const Pu = scale(sub(rot(c.eval(u + h), v), rot(c.eval(u - h), v)), 1 / (2 * h));
        return [P, Pu, cross(a, sub(P, base))];
      };
      return {
        name, eval: (u, v) => d(u, v)[0], d,
        project: (q) => {
          // Rotate q into the profile's half-plane, find the profile parameter, then refine.
          const p0 = c.eval(c.range ? (c.range[0] + c.range[1]) / 2 : 0);
          const w0 = sub(p0, base), x0 = unit(sub(w0, scale(a, dot(w0, a))));
          const wq = sub(q, base), xq = sub(wq, scale(a, dot(wq, a)));
          const ang = Math.atan2(dot(cross(x0, xq), a), dot(x0, xq));
          const u = c.param(rot(q, -ang));
          return newtonProject(d, q, u, ang);
        },
      };
    }
    case 'OFFSET_SURF': {
      const bn = g.ref(n, 'surface');
      if (!bn) throw new GeomError('Offset surface without base');
      const b = makeSurface(g, bn), o = num(n, 'offset') * sign(bn);
      const h = 1e-6;
      const at = (u: number, v: number): Vec3 => { const [P, Pu, Pv] = b.d(u, v); return add(P, scale(unit(cross(Pu, Pv)), o)); };
      const d = (u: number, v: number): [Vec3, Vec3, Vec3] => [
        at(u, v), scale(sub(at(u + h, v), at(u - h, v)), 1 / (2 * h)), scale(sub(at(u, v + h), at(u, v - h)), 1 / (2 * h)),
      ];
      return {
        name, eval: at, d,
        project: (q) => { const r = b.project(q); return newtonProject(d, q, r.u, r.v); },
      };
    }
  }
  throw new GeomError(`Unsupported surface ${name}`);
}

export function nurbsSurfaceOf(s: NurbsSurf, name = 'B_SURFACE'): Surface {
  const u0 = s.uk[s.du], u1 = s.uk[s.nu], v0 = s.vk[s.dv], v1 = s.vk[s.nv];
  const clamp = (u: number, v: number): [number, number] => [Math.min(u1, Math.max(u0, u)), Math.min(v1, Math.max(v0, v))];
  const d = (u: number, v: number) => nurbsSurfEval(s, u, v);
  return { name, eval: (u, v) => d(u, v)[0], d, project: gridProject(d, u0, u1, v0, v1, Math.min(48, 4 * Math.max(s.nu, s.nv)), clamp) };
}

/** Point on the intersection of two surfaces nearest to q. */
export function onBoth(a: Surface, b: Surface, q: Vec3): Vec3 {
  let x = q;
  let sa: [number, number] | undefined, sb: [number, number] | undefined;
  for (let k = 0; k < 12; k++) {
    const pa = a.project(x, sa), pb = b.project(x, sb);
    sa = [pa.u, pa.v];
    sb = [pb.u, pb.v];
    const da = dot(pa.n, sub(x, pa.p)), db = dot(pb.n, sub(x, pb.p));
    if (Math.abs(da) + Math.abs(db) < 1e-13) break;
    const c = dot(pa.n, pb.n);
    if (1 - Math.abs(c) < 1e-6) { x = scale(add(pa.p, pb.p), 0.5); continue; }
    // Move within span(na, nb) so both signed distances vanish.
    const s = -da, t = -db, det = 1 - c * c;
    const alpha = (s - c * t) / det, beta = (t - c * s) / det;
    x = add(x, add(scale(pa.n, alpha), scale(pb.n, beta)));
  }
  return x;
}
