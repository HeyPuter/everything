// Writes Parasolid bodies as a STEP (AP214) B-rep that the geometry kernel's
// STEP reader imports.
//
// Geometry is exact wherever STEP has the type: lines, circles, ellipses and
// B-spline curves; planes, cylinders, cones, spheres, tori, B-spline,
// extruded, revolved and offset surfaces. Curves with no STEP counterpart
// (surface intersections, curves in a surface's parameter space, edges whose
// geometry lives on their faces) are sampled from their exact evaluators into
// cubic splines within a tight tolerance, and rolling-ball blends are rebuilt
// as rational B-spline surfaces. Parasolid works in metres; the file is
// written in millimetres.

import type { Vec3 } from '../../math/vec';
import { add, cross, dist, dot, len, normalize, scale, sub } from '../../math/vec';
import {
  type Curve, type NurbsSurf, type Surface, Graph, GeomError, makeCurve, nurbsCurve, nurbsSurface, nurbsSurfaceOf, num, sign, supportContact, vec,
} from './geom';
import type { XtNode } from './xt';

const MM = 1000;

export interface StepResult {
  text: string;
  solids: number;
  sheets: number;
  faces: number;
  /** Faces whose surface was rebuilt approximately (blends). */
  approximated: number;
  /** Faces left out because their surface could not be represented. */
  skipped: number;
  /** Why faces or edges were left out, for diagnostics. */
  problems: string[];
}

function real(x: number): string {
  if (!Number.isFinite(x)) return '0.';
  if (Object.is(x, -0) || x === 0) return '0.';
  let s = String(x);
  if (s.includes('e')) {
    const [m, e] = s.split('e');
    s = `${m.includes('.') ? m : `${m}.`}E${e.replace('+', '')}`;
  } else if (!s.includes('.')) s += '.';
  return s;
}

const ref = (id: number) => `#${id}`;
const list = (ids: number[]) => `(${ids.map(ref).join(',')})`;
const reals = (xs: number[]) => `(${xs.map(real).join(',')})`;
const ints = (xs: number[]) => `(${xs.join(',')})`;
const bool = (b: boolean) => (b ? '.T.' : '.F.');

/** Distinct knots and multiplicities of an expanded knot vector. */
function compress(knots: number[]): [number[], number[]] {
  const k: number[] = [], m: number[] = [];
  for (const t of knots) {
    if (k.length && Math.abs(t - k[k.length - 1]) <= 1e-14 * (1 + Math.abs(t))) m[m.length - 1]++;
    else { k.push(t); m.push(1); }
  }
  return [k, m];
}

interface Spline { pts: Vec3[]; knots: number[] }

/** A cubic spline through a curve within `tol`: Bezier segments from the
 *  curve's points and tangents, split until each matches the curve. */
function sampleCurve(ev: (t: number) => Vec3, t0: number, t1: number, tol: number, maxSegs = 1024): Spline {
  const h = (t1 - t0) * 1e-6;
  // One-sided derivatives keep tangents correct at kinks in the parametrization.
  const dFwd = (t: number) => scale(sub(ev(t + h), ev(t)), 1 / h);
  const dBwd = (t: number) => scale(sub(ev(t), ev(t - h)), 1 / h);
  const seg = (a: number, b: number): Vec3[] => {
    const P0 = ev(a), P3 = ev(b), k = (b - a) / 3;
    return [P0, add(P0, scale(dFwd(a), k)), sub(P3, scale(dBwd(b), k)), P3];
  };
  const bez = (c: Vec3[], s: number): Vec3 => {
    const r = 1 - s;
    return add(add(scale(c[0], r * r * r), scale(c[1], 3 * r * r * s)), add(scale(c[2], 3 * r * s * s), scale(c[3], s * s * s)));
  };
  const out: [number, Vec3[]][] = [];
  const stack: [number, number, number][] = [];
  const n0 = 4;
  for (let i = n0 - 1; i >= 0; i--) stack.push([t0 + ((t1 - t0) * i) / n0, t0 + ((t1 - t0) * (i + 1)) / n0, 0]);
  while (stack.length) {
    const [a, b, depth] = stack.pop()!;
    const c = seg(a, b);
    let err = 0;
    for (const s of [0.25, 0.5, 0.75]) err = Math.max(err, dist(bez(c, s), ev(a + (b - a) * s)));
    if (err > tol && depth < 12 && out.length + stack.length < maxSegs) {
      const m = (a + b) / 2;
      stack.push([m, b, depth + 1], [a, m, depth + 1]);
    } else out.push([a, c]);
  }
  const pts: Vec3[] = [out[0][1][0]];
  const knots = [0, 0, 0, 0];
  let acc = 0;
  for (const [, c] of out) {
    pts.push(c[1], c[2], c[3]);
    acc += Math.max(dist(c[0], c[3]), 1e-12);
    knots.push(acc, acc, acc);
  }
  knots.push(acc);
  return { pts, knots };
}

/** Global cubic interpolation of rows of values (The NURBS Book A9.1), chord-length parametrized by `params`. */
function interpolate(rows: number[][], params: number[]): { ctrl: number[][]; knots: number[] } {
  const n = rows.length, p = Math.min(3, n - 1);
  const knots = new Array<number>(n + p + 1).fill(0);
  for (let i = 0; i <= p; i++) { knots[i] = params[0]; knots[n + i] = params[n - 1]; }
  for (let j = 1; j < n - p; j++) {
    let s = 0;
    for (let i = j; i < j + p; i++) s += params[i];
    knots[j + p] = s / p;
  }
  const basisRow = (t: number): number[] => {
    const N = new Array<number>(n).fill(0);
    if (t >= knots[n]) { N[n - 1] = 1; return N; }
    let k = p;
    while (k < n - 1 && t >= knots[k + 1]) k++;
    const b = new Array<number>(p + 1).fill(0), left = new Array<number>(p + 1).fill(0), right = new Array<number>(p + 1).fill(0);
    b[0] = 1;
    for (let j = 1; j <= p; j++) {
      left[j] = t - knots[k + 1 - j];
      right[j] = knots[k + j] - t;
      let saved = 0;
      for (let r = 0; r < j; r++) {
        const tmp = b[r] / (right[r + 1] + left[j - r]);
        b[r] = saved + right[r + 1] * tmp;
        saved = left[j - r] * tmp;
      }
      b[j] = saved;
    }
    for (let j = 0; j <= p; j++) N[k - p + j] = b[j];
    return N;
  };
  const A = params.map(basisRow);
  const m = rows[0].length;
  const B = rows.map((r) => r.slice());
  // Gaussian elimination with partial pivoting (systems are small).
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    [B[c], B[piv]] = [B[piv], B[c]];
    const d = A[c][c];
    if (Math.abs(d) < 1e-300) throw new GeomError('Singular interpolation');
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / d;
      if (!f) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      for (let k = 0; k < m; k++) B[r][k] -= f * B[c][k];
    }
  }
  const X = Array.from({ length: n }, () => new Array<number>(m).fill(0));
  for (let r = n - 1; r >= 0; r--) {
    for (let k = 0; k < m; k++) {
      let s = B[r][k];
      for (let c = r + 1; c < n; c++) s -= A[r][c] * X[c][k];
      X[r][k] = s / A[r][r];
    }
  }
  return { ctrl: X, knots };
}

class Writer {
  private out: string[] = [];
  private n = 0;
  add(s: string): number {
    this.n++;
    this.out.push(`#${this.n}=${s};`);
    return this.n;
  }
  point(p: Vec3) { return this.add(`CARTESIAN_POINT('',(${real(p[0] * MM)},${real(p[1] * MM)},${real(p[2] * MM)}))`); }
  dir(d: Vec3) { const u = normalize(d); return this.add(`DIRECTION('',(${real(u[0])},${real(u[1])},${real(u[2])}))`); }
  axis2(o: Vec3, z: Vec3, x: Vec3) {
    // Re-orthogonalize x against z: STEP readers reject skewed placements.
    const zz = normalize(z), xx = normalize(sub(x, scale(zz, dot(x, zz))));
    return this.add(`AXIS2_PLACEMENT_3D('',${ref(this.point(o))},${ref(this.dir(zz))},${ref(this.dir(xx))})`);
  }
  get body() { return this.out.join('\n'); }
}

export interface StepPart { graph: Graph; bodies: XtNode[] }

export function writeStep(parts: StepPart[], name: string): StepResult {
  const w = new Writer();
  const res: StepResult = { text: '', solids: 0, sheets: 0, faces: 0, approximated: 0, skipped: 0, problems: [] };

  // Model extent sets the sampling tolerance.
  let lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const n of parts.flatMap((pt) => [...pt.graph.nodes.values()])) {
    if (n.name !== 'POINT') continue;
    const p = n.f.pvec as Vec3;
    if (!Array.isArray(p) || !p.every(Number.isFinite)) continue;
    lo = lo.map((v, i) => Math.min(v, p[i])) as Vec3;
    hi = hi.map((v, i) => Math.max(v, p[i])) as Vec3;
  }
  const diag = Number.isFinite(lo[0]) ? Math.max(dist(lo, hi), 1e-3) : 0.1;
  const tol = Math.max(diag * 1e-6, 1e-9);

  const items = parts.flatMap((pt) => emitBodies(w, pt.graph, pt.bodies, tol, res));

  const safe = name.replace(/[^\x20-\x7e]/g, '_').replace(/'/g, "''");
  const appCtx = w.add(`APPLICATION_CONTEXT('automotive design')`);
  w.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${ref(appCtx)})`);
  const prodCtx = w.add(`PRODUCT_CONTEXT('',${ref(appCtx)},'mechanical')`);
  const prod = w.add(`PRODUCT('${safe}','${safe}','',(${ref(prodCtx)}))`);
  const pdf = w.add(`PRODUCT_DEFINITION_FORMATION('','',${ref(prod)})`);
  const pdc = w.add(`PRODUCT_DEFINITION_CONTEXT('part definition',${ref(appCtx)},'design')`);
  const pd = w.add(`PRODUCT_DEFINITION('design','',${ref(pdf)},${ref(pdc)})`);
  const pds = w.add(`PRODUCT_DEFINITION_SHAPE('','',${ref(pd)})`);
  const lu = w.add(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`);
  const au = w.add(`(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`);
  const su = w.add(`(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`);
  const unc = w.add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(${real(Math.max(tol * MM, 1e-6))}),${ref(lu)},'distance_accuracy_value','')`);
  const gctx = w.add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${ref(unc)}))GLOBAL_UNIT_ASSIGNED_CONTEXT((${ref(lu)},${ref(au)},${ref(su)}))REPRESENTATION_CONTEXT('',''))`);
  const origin = w.axis2([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const rep = w.add(`ADVANCED_BREP_SHAPE_REPRESENTATION('',${list([origin, ...items])},${ref(gctx)})`);
  w.add(`SHAPE_DEFINITION_REPRESENTATION(${ref(pds)},${ref(rep)})`);

  res.text = [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION(('Converted from a SolidWorks part'),'2;1');`,
    `FILE_NAME('${safe}','${new Date().toISOString().slice(0, 19)}',(''),(''),'Parametric','Parametric','');`,
    `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));`,
    'ENDSEC;',
    'DATA;',
    w.body,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
  return res;
}

function evalRows(fit: { ctrl: number[][]; knots: number[] }, t: number): number[] {
  const n = fit.ctrl.length, p = Math.min(3, n - 1), k = fit.knots;
  // de Boor on the row vectors.
  let s = p;
  while (s < n - 1 && t >= k[s + 1]) s++;
  const d = Array.from({ length: p + 1 }, (_, j) => fit.ctrl[s - p + j].slice());
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = s - p + j;
      const den = k[i + p - r + 1] - k[i];
      const a = den ? (t - k[i]) / den : 0;
      d[j] = d[j].map((x, q) => (1 - a) * d[j - 1][q] + a * x);
    }
  }
  return d[p];
}

/** Writes the bodies of one Parasolid transmit; returns their representation items. */
function emitBodies(w: Writer, g: Graph, bodies: XtNode[], tol: number, res: StepResult): number[] {
  const curveCache = new Map<number, Curve | null>();
  const curveOf = (n: XtNode): Curve | null => {
    if (!curveCache.has(n.id)) {
      try { curveCache.set(n.id, makeCurve(g, n)); } catch { curveCache.set(n.id, null); }
    }
    return curveCache.get(n.id)!;
  };

  const pointOf = (v: XtNode | undefined): Vec3 | null => {
    const p = v && g.ref(v, 'point');
    const pv = p?.f.pvec as Vec3 | undefined;
    return pv && pv.every(Number.isFinite) ? pv : null;
  };

  // ---- vertices ----
  const vertexIds = new Map<number, number>();
  const vertexOut = (v: XtNode, p: Vec3) => {
    let id = vertexIds.get(v.id);
    if (!id) { id = w.add(`VERTEX_POINT('',${ref(w.point(p))})`); vertexIds.set(v.id, id); }
    return id;
  };

  // ---- curves ----
  const lineOut = (p: Vec3, d: Vec3) => w.add(`LINE('',${ref(w.point(p))},${ref(w.add(`VECTOR('',${ref(w.dir(d))},1.)`))})`);
  const conicOut = (n: XtNode) => {
    const ax = w.axis2(vec(n, 'centre'), vec(n, 'normal'), vec(n, 'x_axis'));
    return n.name === 'CIRCLE'
      ? w.add(`CIRCLE('',${ref(ax)},${real(num(n, 'radius') * MM)})`)
      : w.add(`ELLIPSE('',${ref(ax)},${real(num(n, 'major_radius') * MM)},${real(num(n, 'minor_radius') * MM)})`);
  };
  const bcurveOut = (n: XtNode) => {
    const c = nurbsCurve(g, n);
    const pts = c.ctrl.map((h) => (c.rational ? [h[0] / h[3], h[1] / h[3], h[2] / h[3]] : h.slice(0, 3)) as Vec3);
    const [k, m] = compress(c.knots);
    const ids = pts.map((p) => w.point(p));
    if (!c.rational) return w.add(`B_SPLINE_CURVE_WITH_KNOTS('',${c.degree},${list(ids)},.UNSPECIFIED.,.F.,.F.,${ints(m)},${reals(k)},.UNSPECIFIED.)`);
    return w.add(`(BOUNDED_CURVE()B_SPLINE_CURVE(${c.degree},${list(ids)},.UNSPECIFIED.,.F.,.F.)B_SPLINE_CURVE_WITH_KNOTS(${ints(m)},${reals(k)},.UNSPECIFIED.)CURVE()GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_CURVE(${reals(c.ctrl.map((h) => h[3]))})REPRESENTATION_ITEM(''))`);
  };
  const splineOut = (s: Spline) => {
    const [k, m] = compress(s.knots);
    return w.add(`B_SPLINE_CURVE_WITH_KNOTS('',3,${list(s.pts.map((p) => w.point(p)))},.UNSPECIFIED.,.F.,.F.,${ints(m)},${reals(k)},.UNSPECIFIED.)`);
  };

  const exact = new Set(['LINE', 'CIRCLE', 'ELLIPSE', 'B_CURVE']);
  const wrapPos = (a: number, p: number) => ((a % p) + p) % p;

  /** The geometry of an edge from S to E: an exact curve and its sense, or a sampled spline. */
  const edgeGeometry = (e: XtNode, pos: XtNode, S: Vec3, E: Vec3, closed: boolean): { curve: number; same: boolean } => {
    let c = g.ref(e, 'curve');
    if (!c) {
      // Tolerant edge: its geometry is the curve of one of its halfedges.
      c = g.ref(pos, 'curve') ?? g.ref(g.ref(pos, 'other') ?? pos, 'curve');
    }
    if (!c) {
      if (!closed && dist(S, E) > 0) return { curve: lineOut(S, sub(E, S)), same: true };
      throw new GeomError('Edge without geometry');
    }
    let basis = c, trimmed: XtNode | null = null;
    if (c.name === 'TRIMMED_CURVE' && g.ref(c, 'basis_curve')) { trimmed = c; basis = g.ref(c, 'basis_curve')!; }
    // A halfedge's own untrimmed curve runs with the halfedge, not the edge: sample it.
    if (exact.has(basis.name) && (trimmed || c === g.ref(e, 'curve'))) {
      let same: boolean;
      if (basis.name === 'LINE') same = closed ? sign(c) > 0 : dot(sub(E, S), vec(basis, 'direction')) > 0;
      else if (!trimmed || closed) same = sign(c) > 0;
      else if (basis.name === 'B_CURVE') {
        // The trimmed curve runs with the edge when its sense is '+', and
        // with its basis unless the basis has sense '-'.
        same = sign(c) * sign(basis) > 0;
      } else {
        // On a circle or ellipse, take the arc through the trimmed interval's middle.
        const cv = curveOf(basis)!;
        let t1 = num(trimmed, 'parm_1'), t2 = num(trimmed, 'parm_2');
        if (sign(basis) < 0) [t1, t2] = [t2, t1];
        const P = cv.period ?? 2 * Math.PI;
        const mid = cv.eval(t1 + wrapPos(t2 - t1, P) / 2);
        const tS = cv.param(S);
        same = wrapPos(cv.param(mid) - tS, P) < wrapPos(cv.param(E) - tS, P);
      }
      const curve = basis.name === 'LINE' ? lineOut(vec(basis, 'pvec'), vec(basis, 'direction'))
        : basis.name === 'B_CURVE' ? bcurveOut(basis) : conicOut(basis);
      return { curve, same };
    }
    const cv = curveOf(c);
    if (!cv) throw new GeomError(`Unsupported curve ${c.name}`);
    let t0: number, t1: number;
    if (closed) {
      if (!cv.range) throw new GeomError('Closed edge on an unbounded curve');
      [t0, t1] = sign(c) > 0 ? cv.range : [cv.range[1], cv.range[0]];
    } else {
      t0 = cv.param(S);
      t1 = cv.param(E, t0);
      if (cv.period) {
        // Go the way the curve's sense says.
        if (sign(c) > 0 && t1 <= t0) t1 += cv.period;
        if (sign(c) < 0 && t1 >= t0) t1 -= cv.period;
      }
    }
    const spline = sampleCurve(cv.eval, t0, t1, tol);
    // Pin the ends to the vertices exactly.
    spline.pts[0] = S;
    spline.pts[spline.pts.length - 1] = closed ? S : E;
    return { curve: splineOut(spline), same: true };
  };

  /** An edge's positive halfedge and its start and end vertices: a
   *  halfedge's vertex is the one at its forward end. */
  const edgeEnds = (e: XtNode) => {
    const h = g.ref(e, 'halfedge');
    if (!h) throw new GeomError('Edge without halfedges');
    const other = g.ref(h, 'other');
    const pos = h.f.sense === '-' && other ? other : h;
    const endV = g.ref(pos, 'vertex');
    const startV = g.ref(g.ref(pos, 'other') ?? g.ref(pos, 'backward') ?? pos, 'vertex');
    return { pos, startV, endV, S: pointOf(startV), E: pointOf(endV) };
  };

  const edgeIds = new Map<number, number | null>();
  const edgeOut = (e: XtNode): number | null => {
    if (edgeIds.has(e.id)) return edgeIds.get(e.id)!;
    let result: number | null = null;
    try {
      const ends = edgeEnds(e);
      const { pos, startV, endV } = ends;
      let { S, E } = ends;
      const closed = !startV || !endV || startV === endV;
      let vs: number, ve: number;
      if (closed) {
        const v = startV ?? endV;
        if (!S) S = E;
        if (!S) {
          // Ring edge with no vertex: put one where the curve starts.
          const c = g.ref(e, 'curve') ?? g.ref(pos, 'curve');
          const cv = c && curveOf(c);
          if (!cv?.range) throw new GeomError('Ring edge without a bounded curve');
          S = cv.eval(sign(c) > 0 ? cv.range[0] : cv.range[1]);
        }
        E = S;
        vs = ve = v ? vertexOut(v, S) : w.add(`VERTEX_POINT('',${ref(w.point(S))})`);
      } else {
        if (!S || !E) throw new GeomError('Vertex without a point');
        vs = vertexOut(startV!, S);
        ve = vertexOut(endV!, E);
      }
      const { curve, same } = edgeGeometry(e, pos, S!, E!, closed);
      result = w.add(`EDGE_CURVE('',${ref(vs)},${ref(ve)},${ref(curve)},${bool(same)})`);
    } catch (err) {
      res.problems.push(`edge ${e.id}: ${(err as Error).message}`);
      result = null;
    }
    edgeIds.set(e.id, result);
    return result;
  };

  // ---- surfaces ----
  const nurbsSurfOut = (ctrl: number[][][], du: number, dv: number, uk: number[], vk: number[], rational: boolean) => {
    const rows = ctrl.map((row) => list(row.map((h) => w.point((rational ? [h[0] / h[3], h[1] / h[3], h[2] / h[3]] : h.slice(0, 3)) as Vec3))));
    const [uK, uM] = compress(uk), [vK, vM] = compress(vk);
    const net = `(${rows.join(',')})`;
    if (!rational) return w.add(`B_SPLINE_SURFACE_WITH_KNOTS('',${du},${dv},${net},.UNSPECIFIED.,.F.,.F.,.F.,${ints(uM)},${ints(vM)},${reals(uK)},${reals(vK)},.UNSPECIFIED.)`);
    const weights = `(${ctrl.map((row) => reals(row.map((h) => h[3]))).join(',')})`;
    return w.add(`(BOUNDED_SURFACE()B_SPLINE_SURFACE(${du},${dv},${net},.UNSPECIFIED.,.F.,.F.,.F.)B_SPLINE_SURFACE_WITH_KNOTS(${ints(uM)},${ints(vM)},${reals(uK)},${reals(vK)},.UNSPECIFIED.)GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_SURFACE(${weights})REPRESENTATION_ITEM('')SURFACE())`);
  };

  /** A curve entity for a swept or spun surface's profile. */
  const profileOut = (c: XtNode): number => {
    if (c.name === 'LINE') return lineOut(vec(c, 'pvec'), vec(c, 'direction'));
    if (c.name === 'CIRCLE' || c.name === 'ELLIPSE') return conicOut(c);
    if (c.name === 'B_CURVE') return bcurveOut(c);
    if (c.name === 'TRIMMED_CURVE' && g.ref(c, 'basis_curve')) return profileOut(g.ref(c, 'basis_curve')!);
    const cv = curveOf(c);
    if (!cv?.range) throw new GeomError(`Unsupported profile ${c.name}`);
    return splineOut(sampleCurve(cv.eval, cv.range[0], cv.range[1], tol));
  };

  /** Exact surface entity, and whether its natural normal is the reverse of Parasolid's. */
  const surfIds = new Map<number, { id: number; flip: boolean } | null>();
  const surfaceOut = (s: XtNode): { id: number; flip: boolean } | null => {
    if (surfIds.has(s.id)) return surfIds.get(s.id)!;
    let r: { id: number; flip: boolean } | null = null;
    try {
      switch (s.name) {
        case 'PLANE': r = { id: w.add(`PLANE('',${ref(w.axis2(vec(s, 'pvec'), vec(s, 'normal'), vec(s, 'x_axis')))})`), flip: false }; break;
        case 'CYLINDER': r = { id: w.add(`CYLINDRICAL_SURFACE('',${ref(w.axis2(vec(s, 'pvec'), vec(s, 'axis'), vec(s, 'x_axis')))},${real(num(s, 'radius') * MM)})`), flip: false }; break;
        case 'CONE': {
          const ang = Math.atan2(num(s, 'sin_half_angle'), num(s, 'cos_half_angle'));
          r = { id: w.add(`CONICAL_SURFACE('',${ref(w.axis2(vec(s, 'pvec'), vec(s, 'axis'), vec(s, 'x_axis')))},${real(num(s, 'radius') * MM)},${real(ang)})`), flip: false };
          break;
        }
        case 'SPHERE': r = { id: w.add(`SPHERICAL_SURFACE('',${ref(w.axis2(vec(s, 'centre'), vec(s, 'axis'), vec(s, 'x_axis')))},${real(num(s, 'radius') * MM)})`), flip: false }; break;
        case 'TORUS': r = { id: w.add(`TOROIDAL_SURFACE('',${ref(w.axis2(vec(s, 'centre'), vec(s, 'axis'), vec(s, 'x_axis')))},${real(num(s, 'major_radius') * MM)},${real(num(s, 'minor_radius') * MM)})`), flip: false }; break;
        case 'B_SURFACE': {
          const n = nurbsSurface(g, s);
          r = { id: nurbsSurfOut(n.ctrl, n.du, n.dv, n.uk, n.vk, n.rational), flip: false };
          break;
        }
        case 'SWEPT_SURF': {
          const d = vec(s, 'sweep');
          const prof = profileOut(g.ref(s, 'section')!);
          r = { id: w.add(`SURFACE_OF_LINEAR_EXTRUSION('',${ref(prof)},${ref(w.add(`VECTOR('',${ref(w.dir(d))},${real(len(d) * MM)})`))})`), flip: false };
          break;
        }
        case 'SPUN_SURF': {
          const prof = profileOut(g.ref(s, 'profile')!);
          const ax = w.add(`AXIS1_PLACEMENT('',${ref(w.point(vec(s, 'base')))},${ref(w.dir(vec(s, 'axis')))})`);
          // STEP puts the angle in u and the profile in v, the reverse of Parasolid.
          r = { id: w.add(`SURFACE_OF_REVOLUTION('',${ref(prof)},${ref(ax)})`), flip: true };
          break;
        }
        case 'OFFSET_SURF': {
          const base = g.ref(s, 'surface');
          const b = base && surfaceOut(base);
          if (!b) break;
          r = { id: w.add(`OFFSET_SURFACE('',${ref(b.id)},${real(num(s, 'offset') * sign(base) * (b.flip ? -1 : 1) * MM)},.F.)`), flip: b.flip };
          break;
        }
      }
    } catch {
      r = null;
    }
    surfIds.set(s.id, r);
    return r;
  };

  // ---- rolling-ball blends ----

  /** The rolling-ball surface over the spine interval the face occupies. */
  const blendOut = (s: XtNode, facePts: Vec3[]): { id: number; surf: Surface } => {
    const spineNode = g.ref(s, 'spine');
    const spine = spineNode && curveOf(spineNode);
    const supports = g.refs(s, 'surface');
    if (!spine || supports.length !== 2 || !supports[0] || !supports[1] || !facePts.length) throw new GeomError('blend without spine or supports');
    const touch = supports.map((q) => supportContact(g, q!));
    if (!touch[0] || !touch[1]) throw new GeomError(`unsupported blend supports ${supports.map((q) => q!.name)}`);
    const section = (t: number): number[] | null => {
      const c = spine.eval(t);
      const p1 = touch[0]!(c), p2 = touch[1]!(c);
      const r1 = dist(p1, c), r2 = dist(p2, c);
      if (r1 < 1e-12 || r2 < 1e-12) return null;
      const e1 = scale(sub(p1, c), 1 / r1), e2 = scale(sub(p2, c), 1 / r2);
      const cosT = Math.max(-1, Math.min(1, dot(e1, e2)));
      if (cosT < -0.999) return null;
      const wgt = Math.sqrt((1 + cosT) / 2); // cos(theta / 2)
      const r = (r1 + r2) / 2;
      const mid = add(c, scale(normalize(add(e1, e2)), r / wgt));
      return [...p1, 1, ...scale(mid, wgt), wgt, ...p2, 1];
    };
    // Spine interval covering the face.
    const ts = facePts.map((p) => spine.param(p));
    let t0: number, t1: number;
    const P = spine.period;
    if (P) {
      // Smallest arc containing every parameter.
      const sorted = ts.map((t) => ((t % P) + P) % P).sort((a, b) => a - b);
      let gap = sorted[0] + P - sorted[sorted.length - 1], at = 0;
      for (let i = 1; i < sorted.length; i++) if (sorted[i] - sorted[i - 1] > gap) { gap = sorted[i] - sorted[i - 1]; at = i; }
      if (gap < P * 0.02) { t0 = 0; t1 = P; } else {
        t0 = sorted[at];
        t1 = at === 0 ? sorted[sorted.length - 1] : sorted[at - 1] + P;
        const pad = (t1 - t0) * 0.03;
        t0 -= pad; t1 += pad;
      }
    } else {
      t0 = Math.min(...ts); t1 = Math.max(...ts);
      const pad = (t1 - t0) * 0.03;
      t0 -= pad; t1 += pad;
      if (spine.range) { t0 = Math.max(t0, spine.range[0]); t1 = Math.min(t1, spine.range[1]); }
    }
    if (!(t1 > t0)) throw new GeomError('blend spans no spine interval');
    // Fit rows of the rational arc along the spine until midway sections agree.
    for (let n = 9; n <= 257; n = 2 * n - 1) {
      const params = Array.from({ length: n }, (_, i) => t0 + ((t1 - t0) * i) / (n - 1));
      const rows = params.map(section);
      if (rows.some((r) => !r)) throw new GeomError(`blend section fails (supports ${supports.map((q) => q!.name)})`);
      const fit = interpolate(rows as number[][], params);
      let err = 0;
      for (let i = 0; i + 1 < n; i++) {
        const t = (params[i] + params[i + 1]) / 2;
        const exactRow = section(t);
        if (!exactRow) throw new GeomError('blend section fails');
        const got = evalRows(fit, t);
        for (let k = 0; k < 3; k++) {
          const wa = exactRow[k * 4 + 3], wb = got[k * 4 + 3];
          err = Math.max(err, dist(exactRow.slice(k * 4, k * 4 + 3).map((x) => x / wa) as Vec3, got.slice(k * 4, k * 4 + 3).map((x) => x / wb) as Vec3));
        }
      }
      if (err <= tol || n >= 257) {
        // u along the spine (cubic), v across the arc (rational quadratic).
        const ns: NurbsSurf = {
          du: Math.min(3, n - 1), dv: 2, uk: fit.knots, vk: [0, 0, 0, 1, 1, 1], nu: n, nv: 3, rational: true,
          ctrl: fit.ctrl.map((row) => [row.slice(0, 4), row.slice(4, 8), row.slice(8, 12)]),
        };
        return { id: nurbsSurfOut(ns.ctrl, ns.du, ns.dv, ns.uk, ns.vk, true), surf: nurbsSurfaceOf(ns, 'BLEND') };
      }
    }
    throw new GeomError('blend fit did not converge');
  };

  // ---- topology ----

  const loopHalfedges = (lp: XtNode): XtNode[] => {
    const out: XtNode[] = [];
    const first = g.ref(lp, 'halfedge');
    for (let h = first; h && out.length < 100000; h = g.ref(h, 'forward')) {
      out.push(h);
      if (g.ref(h, 'forward') === first) break;
    }
    return out;
  };
  const faceLoops = (f: XtNode): XtNode[] => {
    const out: XtNode[] = [];
    for (let lp = g.ref(f, 'loop'); lp && out.length < 100000; lp = g.ref(lp, 'next')) out.push(lp);
    return out;
  };

  /** Points along an edge from its start to its end vertex. */
  const edgeSamples = (e: XtNode, n = 12): Vec3[] => {
    const { pos, startV, endV, S, E } = edgeEnds(e);
    const c = g.ref(e, 'curve') ?? g.ref(pos, 'curve');
    const cv = c && curveOf(c);
    if (!cv) return S && E ? [S, E] : [];
    let t0: number, t1: number;
    if (!S || !E || startV === endV) {
      if (!cv.range) return [];
      [t0, t1] = sign(c) > 0 ? cv.range : [cv.range[1], cv.range[0]];
    } else {
      t0 = cv.param(S);
      t1 = cv.param(E, t0);
      if (cv.period) {
        if (sign(c) > 0 && t1 <= t0) t1 += cv.period;
        if (sign(c) < 0 && t1 >= t0) t1 -= cv.period;
      }
    }
    return Array.from({ length: n + 1 }, (_, i) => cv.eval(t0 + ((t1 - t0) * i) / n));
  };

  /** Boundary samples of a face, each with its tangent in loop order. */
  const boundarySamples = (f: XtNode): { p: Vec3; t: Vec3 }[] => {
    const out: { p: Vec3; t: Vec3 }[] = [];
    for (const lp of faceLoops(f)) {
      for (const h of loopHalfedges(lp)) {
        const e = g.ref(h, 'edge');
        if (!e) continue;
        const pts = edgeSamples(e);
        if (h.f.sense === '-') pts.reverse();
        for (let i = 1; i + 1 < pts.length; i++) out.push({ p: pts[i], t: sub(pts[i + 1], pts[i - 1]) });
      }
    }
    return out;
  };

  /** Whether the face is on the natural-normal side of a surface: the face
   *  lies to the left of its loops seen from its outward normal. */
  const naturalSide = (surf: Surface, samples: { p: Vec3; t: Vec3 }[]): boolean => {
    if (!samples.length) return true;
    let seed: [number, number] | undefined;
    const uv = samples.map((q) => { const r = surf.project(q.p, seed); seed = [r.u, r.v]; return r; });
    const cu = uv.reduce((a, r) => a + r.u, 0) / uv.length, cvv = uv.reduce((a, r) => a + r.v, 0) / uv.length;
    let vote = 0;
    samples.forEach((q, i) => {
      const [, Su, Sv] = surf.d(uv[i].u, uv[i].v);
      const inward = add(scale(Su, cu - uv[i].u), scale(Sv, cvv - uv[i].v));
      vote += Math.sign(dot(cross(cross(Su, Sv), q.t), inward));
    });
    return vote >= 0;
  };

  const faceOut = (f: XtNode): number | null => {
    const s = g.ref(f, 'surface');
    if (!s) return null;
    let surf: { id: number; flip: boolean } | null = null;
    let same = f.f.sense === s.f.sense;
    if (s.name === 'BLENDED_EDGE') {
      try {
        const samples = boundarySamples(f);
        const blend = blendOut(s, samples.map((q) => q.p));
        res.approximated++;
        surf = { id: blend.id, flip: false };
        // The rebuilt parametrization is our own: orient by the face's loops.
        same = naturalSide(blend.surf, samples);
      } catch (err) {
        res.problems.push(`face ${f.id}: ${(err as Error).message}`);
        return null;
      }
    } else {
      surf = surfaceOut(s);
      if (surf?.flip) same = !same;
    }
    if (!surf) { res.problems.push(`face ${f.id}: unsupported surface ${s.name}`); return null; }
    const bounds: number[] = [];
    for (const lp of faceLoops(f)) {
      const hs = loopHalfedges(lp);
      if (hs.length === 1 && !g.ref(hs[0], 'edge')) {
        const v = g.ref(hs[0], 'vertex'), p = pointOf(v);
        if (v && p) bounds.push(w.add(`FACE_BOUND('',${ref(w.add(`VERTEX_LOOP('',${ref(vertexOut(v, p))})`))},.T.)`));
        continue;
      }
      const oes: number[] = [];
      for (const h of hs) {
        const e = g.ref(h, 'edge');
        const eo = e ? edgeOut(e) : null;
        if (eo === null) { res.problems.push(`face ${f.id}: an edge failed`); return null; }
        oes.push(w.add(`ORIENTED_EDGE('',*,*,${ref(eo)},${bool(h.f.sense !== '-')})`));
      }
      bounds.push(w.add(`FACE_BOUND('',${ref(w.add(`EDGE_LOOP('',${list(oes)})`))},.T.)`));
    }
    res.faces++;
    return w.add(`ADVANCED_FACE('',${list(bounds)},${ref(surf.id)},${bool(same)})`);
  };

  const shellFaces = (sh: XtNode): XtNode[] => {
    const out: XtNode[] = [];
    const seen = new Set<number>();
    for (const field of ['face', 'front_face']) {
      for (let f = g.ref(sh, field); f && !seen.has(f.id); f = g.ref(f, field === 'face' ? 'next' : 'next_front')) {
        seen.add(f.id);
        out.push(f);
      }
    }
    return out;
  };

  const items: number[] = [];
  for (const body of bodies) {
    // A solid's faces are reached from its solid regions' shells; a sheet
    // body has only void regions, whose shells hold its faces.
    const regions: XtNode[] = [];
    for (let rg = g.ref(body, 'region'); rg && regions.length < 10000 && !regions.includes(rg); rg = g.ref(rg, 'next')) regions.push(rg);
    const solid = regions.some((rg) => rg.f.type === 'S');
    const shells: { faces: number[]; size: number }[] = [];
    const seen = new Set<number>();
    for (const rg of regions) {
      if (solid && rg.f.type !== 'S') continue;
      for (let sh = g.ref(rg, 'shell'), j = 0; sh && j < 10000; sh = g.ref(sh, 'next'), j++) {
        const faces: number[] = [];
        let lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
        for (const f of shellFaces(sh)) {
          if (seen.has(f.id)) continue;
          seen.add(f.id);
          const id = faceOut(f);
          if (id === null) res.skipped++;
          else faces.push(id);
          for (const lp of faceLoops(f)) {
            for (const h of loopHalfedges(lp)) {
              const p = pointOf(g.ref(h, 'vertex'));
              if (p) { lo = lo.map((v, i) => Math.min(v, p[i])) as Vec3; hi = hi.map((v, i) => Math.max(v, p[i])) as Vec3; }
            }
          }
        }
        if (faces.length) shells.push({ faces, size: Number.isFinite(lo[0]) ? dist(lo, hi) : 0 });
      }
    }
    if (!shells.length) continue;
    if (solid) {
      // The outer shell encloses the voids, so it is the largest.
      shells.sort((a, b) => b.size - a.size);
      const closed = shells.map((sh) => w.add(`CLOSED_SHELL('',${list(sh.faces)})`));
      if (closed.length === 1) items.push(w.add(`MANIFOLD_SOLID_BREP('',${ref(closed[0])})`));
      else {
        const voids = closed.slice(1).map((sh) => w.add(`ORIENTED_CLOSED_SHELL('',*,${ref(sh)},.F.)`));
        items.push(w.add(`BREP_WITH_VOIDS('',${ref(closed[0])},${list(voids)})`));
      }
      res.solids++;
    } else {
      items.push(w.add(`SHELL_BASED_SURFACE_MODEL('',(${ref(w.add(`OPEN_SHELL('',${list(shells.flatMap((sh) => sh.faces))})`))}))`));
      res.sheets++;
    }
  }
  return items;
}
