// Curve types on top of the curves component: poly, Bézier, NURBS and Catmull-Rom splines.
//
// Control points live in `CurvesComponent.positions`; the spline type and its settings are
// built-in attributes with `bpy` names:
//   CURVE: curve_type (INT8: 0 Catmull-Rom, 1 poly, 2 Bézier, 3 NURBS), resolution (INT),
//          nurbs_order (INT8), knots_mode (INT8), normal_mode (INT8)
//   POINT: handle_left / handle_right (FLOAT_VECTOR), handle_type_left / handle_type_right
//          (INT8: 0 free, 1 auto, 2 vector, 3 align), nurbs_weight (FLOAT), tilt, radius,
//          custom_normal (FLOAT_VECTOR)
// A component without `curve_type` holds poly curves only. `evaluateCurves` turns any component
// into poly curves made of the evaluated points (what is drawn, swept and sampled).
import { CurvesComponent, interpArray, type AttrMap, type Interp } from '../geometry';
import { dataComps, type AttrArray, type DataType } from '../types';
import { curveTangents, curveNormals, curveLengths, endTangentOverrides } from '../curveutil';

export const CT = { CATMULL_ROM: 0, POLY: 1, BEZIER: 2, NURBS: 3 } as const;
export const CURVE_TYPE_IDS = ['CATMULL_ROM', 'POLY', 'BEZIER', 'NURBS'] as const;
export const HT = { FREE: 0, AUTO: 1, VECTOR: 2, ALIGN: 3 } as const;
export const HANDLE_TYPE_IDS = ['FREE', 'AUTO', 'VECTOR', 'ALIGN'] as const;
export const KNOTS = {
  NORMAL: 0,
  ENDPOINT: 1,
  BEZIER: 2,
  ENDPOINT_BEZIER: 3,
} as const;
export const NORMAL_MODE = { MINIMUM_TWIST: 0, Z_UP: 1, FREE: 2 } as const;

export const DEFAULT_RESOLUTION = 12;
export const DEFAULT_ORDER = 4;

/** Values of built-in curve attributes when they are missing. */
export const CURVE_ATTR_DEFAULTS: Record<string, number> = {
  curve_type: CT.POLY,
  resolution: DEFAULT_RESOLUTION,
  nurbs_order: DEFAULT_ORDER,
  nurbs_weight: 1,
};

/** Attributes that only describe control points (not interpolated onto evaluated points). */
const CONTROL_ONLY = new Set(['handle_left', 'handle_right', 'handle_type_left', 'handle_type_right', 'nurbs_weight']);
const CURVE_SETTINGS = new Set(['curve_type', 'resolution', 'nurbs_order', 'knots_mode']);

// ---------------------------------------------------------------------------
// Attribute access

/** Integer attribute on the curve domain (missing → filled with `def`). */
export function curveInts(c: CurvesComponent, name: string, def: number): Int32Array {
  const a = c.attrs.get(name);
  const n = c.curveCount;
  if (a && a.domain === 'CURVE' && a.data.length === n) return a.data instanceof Int32Array ? a.data : Int32Array.from(a.data);
  return new Int32Array(n).fill(def);
}

/** Integer attribute on the point domain (missing → filled with `def`). */
export function pointInts(c: CurvesComponent, name: string, def: number): Int32Array {
  const a = c.attrs.get(name);
  const n = c.pointCount;
  if (a && a.domain === 'POINT' && a.data.length === n) return a.data instanceof Int32Array ? a.data : Int32Array.from(a.data);
  return new Int32Array(n).fill(def);
}

export function pointFloats(c: CurvesComponent, name: string, def: number): Float32Array {
  const a = c.attrs.get(name);
  const n = c.pointCount;
  if (a && a.domain === 'POINT' && a.data.length === n) return a.data instanceof Float32Array ? a.data : Float32Array.from(a.data);
  return new Float32Array(n).fill(def);
}

/** Vector attribute on the point domain (missing → copy of `fallback`, or zeros). */
export function pointVectors(c: CurvesComponent, name: string, fallback?: Float32Array): Float32Array {
  const a = c.attrs.get(name);
  if (a && a.domain === 'POINT' && a.type === 'FLOAT_VECTOR' && a.data.length === c.pointCount * 3) return a.data as Float32Array;
  return fallback ? new Float32Array(fallback) : new Float32Array(c.pointCount * 3);
}

/** Spline type per curve, or null when the component holds poly curves only. */
export function curveTypes(c: CurvesComponent): Int32Array | null {
  const a = c.attrs.get('curve_type');
  if (!a || a.domain !== 'CURVE' || a.data.length !== c.curveCount) return null;
  return a.data instanceof Int32Array ? a.data : Int32Array.from(a.data);
}

export function isPolyOnly(c: CurvesComponent): boolean {
  const t = curveTypes(c);
  if (!t) return true;
  for (let i = 0; i < t.length; i++) if (t[i] !== CT.POLY) return false;
  return true;
}

export function hasCurveType(c: CurvesComponent, type: number): boolean {
  const t = curveTypes(c);
  if (!t) return type === CT.POLY && c.curveCount > 0;
  for (let i = 0; i < t.length; i++) if (t[i] === type) return true;
  return false;
}

export function setCurveAttr(attrs: AttrMap, name: string, type: DataType, data: AttrArray) {
  attrs.set(name, { domain: 'CURVE', type, data });
}

export function setPointAttr(attrs: AttrMap, name: string, type: DataType, data: AttrArray) {
  attrs.set(name, { domain: 'POINT', type, data });
}

/** Remove the attributes that only mean something for a spline type no curve uses any more. */
export function pruneTypeAttrs(c: CurvesComponent) {
  const t = curveTypes(c);
  const any = (x: number) => !!t && t.some((v) => v === x);
  if (!t || t.every((v) => v === CT.POLY)) c.attrs.delete('curve_type');
  if (!any(CT.BEZIER)) for (const k of ['handle_left', 'handle_right', 'handle_type_left', 'handle_type_right']) c.attrs.delete(k);
  if (!any(CT.NURBS)) for (const k of ['nurbs_weight', 'nurbs_order', 'knots_mode']) c.attrs.delete(k);
}

// ---------------------------------------------------------------------------
// Handles

const v3 = (a: ArrayLike<number>, i: number): [number, number, number] => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];

/** Auto handle factor: handle length relative to the neighbour distance. */
const AUTO_FACTOR = 2.5614;

/**
 * Recompute derived handles of Bézier curves in place: auto and vector handles from the
 * neighbouring control points, then aligned handles opposite the other handle of their point.
 * `onlyAligned` restricts the pass to aligned handles (after explicit handle edits).
 */
export function recalcHandles(
  P: Float32Array,
  offsets: Uint32Array,
  cyclic: Uint8Array,
  types: Int32Array | null,
  left: Float32Array,
  right: Float32Array,
  tl: Int32Array,
  tr: Int32Array,
  /** also re-align aligned handles opposite the other handle of their point */
  align = true,
) {
  const nc = offsets.length - 1;
  for (let k = 0; k < nc; k++) {
    if (types && types[k] !== CT.BEZIER) continue;
    if (!types) continue;
    const s = offsets[k],
      e = offsets[k + 1],
      n = e - s;
    if (!n) continue;
    const cyc = !!cyclic[k];
    for (let i = s; i < e; i++) {
      const p = v3(P, i);
      const hasPrev = i > s || (cyc && n > 1);
      const hasNext = i < e - 1 || (cyc && n > 1);
      if (tl[i] === HT.FREE && tr[i] === HT.FREE) continue;
      if (tl[i] === HT.ALIGN && tr[i] === HT.ALIGN) continue;
      let prev: number[], next: number[];
      if (n === 1) {
        prev = next = p;
      } else {
        const pi = i > s ? i - 1 : e - 1,
          ni = i < e - 1 ? i + 1 : s;
        next = hasNext ? v3(P, ni) : [2 * p[0] - P[pi * 3], 2 * p[1] - P[pi * 3 + 1], 2 * p[2] - P[pi * 3 + 2]];
        prev = hasPrev ? v3(P, pi) : [2 * p[0] - next[0], 2 * p[1] - next[1], 2 * p[2] - next[2]];
      }
      if (tl[i] === HT.AUTO || tr[i] === HT.AUTO) {
        const da = [p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]],
          db = [next[0] - p[0], next[1] - p[1], next[2] - p[2]];
        let la = Math.hypot(da[0], da[1], da[2]),
          lb = Math.hypot(db[0], db[1], db[2]);
        if (la === 0) la = 1;
        if (lb === 0) lb = 1;
        const t = [da[0] / la + db[0] / lb, da[1] / la + db[1] / lb, da[2] / la + db[2] / lb];
        const len = Math.hypot(t[0], t[1], t[2]) * AUTO_FACTOR;
        const fa = len ? Math.hypot(da[0], da[1], da[2]) / len : 0,
          fb = len ? Math.hypot(db[0], db[1], db[2]) / len : 0;
        if (tl[i] === HT.AUTO) for (let a = 0; a < 3; a++) left[i * 3 + a] = p[a] - t[a] * fa;
        if (tr[i] === HT.AUTO) for (let a = 0; a < 3; a++) right[i * 3 + a] = p[a] + t[a] * fb;
      }
      if (tl[i] === HT.VECTOR) for (let a = 0; a < 3; a++) left[i * 3 + a] = p[a] + (prev[a] - p[a]) / 3;
      if (tr[i] === HT.VECTOR) for (let a = 0; a < 3; a++) right[i * 3 + a] = p[a] + (next[a] - p[a]) / 3;
      if (!align) continue;
      const alignL = tl[i] === HT.ALIGN && tr[i] !== HT.ALIGN;
      const alignR = tr[i] === HT.ALIGN && tl[i] !== HT.ALIGN;
      if (alignL) alignHandle(p, right, left, i);
      else if (alignR) alignHandle(p, left, right, i);
    }
  }
}

/** Point `dst` handle away from the `src` handle, keeping its own length. */
function alignHandle(p: number[], src: Float32Array, dst: Float32Array, i: number) {
  const dx = p[0] - src[i * 3],
    dy = p[1] - src[i * 3 + 1],
    dz = p[2] - src[i * 3 + 2];
  const l = Math.hypot(dx, dy, dz);
  if (l < 1e-12) return;
  const own = Math.hypot(dst[i * 3] - p[0], dst[i * 3 + 1] - p[1], dst[i * 3 + 2] - p[2]);
  dst[i * 3] = p[0] + (dx / l) * own;
  dst[i * 3 + 1] = p[1] + (dy / l) * own;
  dst[i * 3 + 2] = p[2] + (dz / l) * own;
}

export interface HandleData {
  left: Float32Array;
  right: Float32Array;
  tl: Int32Array;
  tr: Int32Array;
}

/** Copies of the handle attributes (positions when missing, free types). */
export function handleData(c: CurvesComponent): HandleData {
  return {
    left: new Float32Array(pointVectors(c, 'handle_left', c.positions)),
    right: new Float32Array(pointVectors(c, 'handle_right', c.positions)),
    tl: new Int32Array(pointInts(c, 'handle_type_left', HT.FREE)),
    tr: new Int32Array(pointInts(c, 'handle_type_right', HT.FREE)),
  };
}

export function writeHandles(c: CurvesComponent, h: HandleData) {
  setPointAttr(c.attrs, 'handle_left', 'FLOAT_VECTOR', h.left);
  setPointAttr(c.attrs, 'handle_right', 'FLOAT_VECTOR', h.right);
  setPointAttr(c.attrs, 'handle_type_left', 'INT8', h.tl);
  setPointAttr(c.attrs, 'handle_type_right', 'INT8', h.tr);
}

/** Component with up-to-date derived (auto, vector, aligned) handles. */
export function withDerivedHandles(c: CurvesComponent): CurvesComponent {
  const types = curveTypes(c);
  if (!types || !types.some((t) => t === CT.BEZIER)) return c;
  const h = handleData(c);
  recalcHandles(c.positions, c.curveOffsets, c.cyclic, types, h.left, h.right, h.tl, h.tr);
  const out = c.copy();
  writeHandles(out, h);
  return out;
}

/**
 * After control points moved (Set Position, transforms): handles move along with their point
 * and derived handles are recomputed.
 */
export function curvesMoved(c: CurvesComponent, oldPositions: Float32Array): CurvesComponent {
  const types = curveTypes(c);
  if (!types || !types.some((t) => t === CT.BEZIER) || !c.attrs.has('handle_left')) return c;
  const h = handleData(c);
  const P = c.positions;
  for (let i = 0; i < P.length; i++) {
    const d = P[i] - oldPositions[i];
    if (!d) continue;
    h.left[i] += d;
    h.right[i] += d;
  }
  recalcHandles(P, c.curveOffsets, c.cyclic, types, h.left, h.right, h.tl, h.tr);
  const out = c.copy();
  writeHandles(out, h);
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation

export function bezierPoint(
  p0: ArrayLike<number>,
  i0: number,
  p1: ArrayLike<number>,
  i1: number,
  p2: ArrayLike<number>,
  i2: number,
  p3: ArrayLike<number>,
  i3: number,
  t: number,
  out: Float32Array | number[],
  o: number,
) {
  const m = 1 - t;
  const a = m * m * m,
    b = 3 * m * m * t,
    c = 3 * m * t * t,
    d = t * t * t;
  for (let k = 0; k < 3; k++) out[o + k] = a * p0[i0 + k] + b * p1[i1 + k] + c * p2[i2 + k] + d * p3[i3 + k];
}

/** Catmull-Rom weights of the four points around a segment at parameter t. */
export function catmullWeights(t: number): [number, number, number, number] {
  const t2 = t * t,
    t3 = t2 * t;
  return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
}

/** Knot vector of a NURBS curve (`count` control points, wrapped for cyclic curves). */
export function nurbsKnots(count: number, order: number, cyclic: boolean, mode: number): number[] {
  const m = count + (cyclic ? order - 1 : 0);
  const total = m + order;
  const knots: number[] = new Array(total);
  const endpoint = !cyclic && (mode === KNOTS.ENDPOINT || mode === KNOTS.ENDPOINT_BEZIER);
  const bezier = mode === KNOTS.BEZIER || mode === KNOTS.ENDPOINT_BEZIER;
  if (bezier && order > 2) {
    // interior knots repeat (order - 1) times so each span is a Bézier segment
    const rep = order - 1;
    const head = endpoint ? order : 2;
    for (let i = 0; i < total; i++) knots[i] = i < head ? 0 : Math.floor((i - head) / rep) + 1;
    if (endpoint) {
      const last = knots[total - order];
      for (let i = total - order; i < total; i++) knots[i] = last;
    }
    return knots;
  }
  for (let i = 0; i < total; i++) knots[i] = endpoint ? Math.min(Math.max(i - order + 1, 0), m - order + 1) : i;
  return knots;
}

/** Non-zero B-spline basis functions of degree order-1 at u in span j (knots[j] ≤ u < knots[j+1]). */
function basis(knots: number[], order: number, j: number, u: number, out: Float64Array) {
  // triangular Cox–de Boor recurrence; out[r] is the basis function of control point j-order+1+r
  const p = order - 1;
  const L = new Float64Array(order),
    Rt = new Float64Array(order);
  out[0] = 1;
  for (let d = 1; d <= p; d++) {
    L[d] = u - knots[j + 1 - d];
    Rt[d] = knots[j + d] - u;
    let saved = 0;
    for (let r = 0; r < d; r++) {
      const den = Rt[r + 1] + L[d - r];
      const tmp = den ? out[r] / den : 0;
      out[r] = saved + Rt[r + 1] * tmp;
      saved = L[d - r] * tmp;
    }
    out[d] = saved;
  }
}

/** Whether a NURBS curve with these settings can be evaluated as a spline (otherwise it acts as poly). */
export function nurbsValid(n: number, order: number, cyclic: boolean, mode: number): boolean {
  if (order < 2 || n < order) return false;
  if (!cyclic && (mode === KNOTS.BEZIER || mode === KNOTS.ENDPOINT_BEZIER) && order > 2) {
    // Bézier knots need whole segments
    if ((n - 1) % (order - 1) !== 0 && mode === KNOTS.ENDPOINT_BEZIER) return false;
  }
  return true;
}

export interface EvaluatedCurves {
  /** poly curves of evaluated points (point attributes interpolated) */
  curves: CurvesComponent;
  /** evaluated index of each control point (-1 when the type has no exact match) */
  controlIndex: Int32Array;
  /** curves whose evaluated points are the control points */
  sameAsControl: boolean;
}

const evalCache = new WeakMap<CurvesComponent, EvaluatedCurves>();

/** Evaluated points of every curve (poly components are returned as they are). */
export function evaluateCurves(c: CurvesComponent): EvaluatedCurves {
  const hit = evalCache.get(c);
  if (hit) return hit;
  const r = computeEvaluated(c);
  evalCache.set(c, r);
  return r;
}

/** Poly curves of the evaluated points. */
export function evaluatedCurves(c: CurvesComponent): CurvesComponent {
  return evaluateCurves(c).curves;
}

function computeEvaluated(c0: CurvesComponent): EvaluatedCurves {
  const types = curveTypes(c0);
  const np = c0.pointCount;
  if (isPolyOnly(c0)) {
    let curves = c0;
    if (types) {
      curves = c0.copy();
      pruneTypeAttrs(curves);
      for (const k of CONTROL_ONLY) curves.attrs.delete(k);
    }
    const idx = new Int32Array(np);
    for (let i = 0; i < np; i++) idx[i] = i;
    return { curves, controlIndex: idx, sameAsControl: true };
  }
  const c = c0;
  const P = c.positions;
  const res = curveInts(c, 'resolution', DEFAULT_RESOLUTION);
  const orders = curveInts(c, 'nurbs_order', DEFAULT_ORDER);
  const knotsMode = curveInts(c, 'knots_mode', KNOTS.NORMAL);
  const weights = pointFloats(c, 'nurbs_weight', 1);
  const left = pointVectors(c, 'handle_left', P),
    right = pointVectors(c, 'handle_right', P);
  const tl = pointInts(c, 'handle_type_left', HT.FREE),
    tr = pointInts(c, 'handle_type_right', HT.FREE);
  const pos: number[] = [];
  const offs: number[] = [0];
  const ipOff: number[] = [0],
    ipSrc: number[] = [],
    ipW: number[] = [];
  const controlIndex = new Int32Array(np).fill(-1);
  const push = (x: number, y: number, z: number) => pos.push(x, y, z);
  const src = (pairs: [number, number][]) => {
    for (const [s, w] of pairs) {
      if (!w) continue;
      ipSrc.push(s);
      ipW.push(w);
    }
    ipOff.push(ipSrc.length);
  };
  const tmp = [0, 0, 0];
  const bw = new Float64Array(16);
  for (let k = 0; k < c.curveCount; k++) {
    const s = c.curveOffsets[k],
      e = c.curveOffsets[k + 1],
      n = e - s;
    const cyc = !!c.cyclic[k];
    const type = types ? types[k] : CT.POLY;
    const R = Math.max(1, res[k]);
    const base = pos.length / 3;
    if (n === 0) {
      offs.push(base);
      continue;
    }
    if (type === CT.BEZIER && n > 1) {
      const segs = cyc ? n : n - 1;
      for (let q = 0; q < segs; q++) {
        const a = s + q,
          b = q + 1 < n ? a + 1 : s;
        controlIndex[a] = pos.length / 3;
        const vector = tr[a] === HT.VECTOR && tl[b] === HT.VECTOR;
        const steps = vector ? 1 : R;
        for (let j = 0; j < steps; j++) {
          const t = j / steps;
          bezierPoint(P, a * 3, right, a * 3, left, b * 3, P, b * 3, t, tmp, 0);
          push(tmp[0], tmp[1], tmp[2]);
          src([
            [a, 1 - t],
            [b, t],
          ]);
        }
      }
      if (!cyc) {
        controlIndex[e - 1] = pos.length / 3;
        push(P[(e - 1) * 3], P[(e - 1) * 3 + 1], P[(e - 1) * 3 + 2]);
        src([[e - 1, 1]]);
      }
    } else if (type === CT.CATMULL_ROM && n > 1) {
      const segs = cyc ? n : n - 1;
      const at = (i: number) => (cyc ? s + ((((i - s) % n) + n) % n) : Math.min(e - 1, Math.max(s, i)));
      for (let q = 0; q < segs; q++) {
        const i1 = s + q;
        const i0 = at(i1 - 1),
          i2 = at(i1 + 1),
          i3 = at(i1 + 2);
        controlIndex[i1] = pos.length / 3;
        for (let j = 0; j < R; j++) {
          const w = catmullWeights(j / R);
          const ids = [i0, i1, i2, i3];
          let x = 0,
            y = 0,
            z = 0;
          for (let m = 0; m < 4; m++) {
            x += P[ids[m] * 3] * w[m];
            y += P[ids[m] * 3 + 1] * w[m];
            z += P[ids[m] * 3 + 2] * w[m];
          }
          push(x, y, z);
          src(ids.map((id, m) => [id, w[m]] as [number, number]));
        }
      }
      if (!cyc) {
        controlIndex[e - 1] = pos.length / 3;
        push(P[(e - 1) * 3], P[(e - 1) * 3 + 1], P[(e - 1) * 3 + 2]);
        src([[e - 1, 1]]);
      }
    } else if (type === CT.NURBS && nurbsValid(n, Math.min(orders[k], 32), cyc, knotsMode[k])) {
      const order = Math.min(orders[k], 32);
      const knots = nurbsKnots(n, order, cyc, knotsMode[k]);
      const m = n + (cyc ? order - 1 : 0);
      const u0 = knots[order - 1],
        u1 = knots[m];
      const segs = Math.max(1, Math.round(u1 - u0));
      const count = R * segs + (cyc ? 0 : 1);
      const steps = cyc ? count : count - 1;
      for (let q = 0; q < count; q++) {
        const u = steps ? u0 + ((u1 - u0) * q) / steps : u0;
        let j = order - 1;
        while (j < m - 1 && knots[j + 1] <= u) j++;
        while (j > order - 1 && knots[j] === knots[j + 1]) j--;
        basis(knots, order, j, u, bw);
        let x = 0,
          y = 0,
          z = 0,
          wsum = 0;
        const pairs: [number, number][] = [];
        for (let r = 0; r < order; r++) {
          const ci = j - order + 1 + r;
          const id = s + (ci % n);
          const w = bw[r] * weights[id];
          wsum += w;
          pairs.push([id, w]);
        }
        for (const pr of pairs) {
          pr[1] = wsum ? pr[1] / wsum : 0;
          x += P[pr[0] * 3] * pr[1];
          y += P[pr[0] * 3 + 1] * pr[1];
          z += P[pr[0] * 3 + 2] * pr[1];
        }
        push(x, y, z);
        // merge duplicate sources of wrapped control points
        const merged = new Map<number, number>();
        for (const [id, w] of pairs) merged.set(id, (merged.get(id) ?? 0) + w);
        src([...merged]);
      }
    } else {
      for (let i = s; i < e; i++) {
        controlIndex[i] = pos.length / 3;
        push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
        src([[i, 1]]);
      }
    }
    offs.push(pos.length / 3);
  }
  const interp: Interp = {
    offsets: Uint32Array.from(ipOff),
    src: Uint32Array.from(ipSrc),
    w: Float32Array.from(ipW),
  };
  const attrs: AttrMap = new Map();
  for (const [name, a] of c.attrs) {
    if (CONTROL_ONLY.has(name) || CURVE_SETTINGS.has(name)) continue;
    if (a.domain === 'CURVE') attrs.set(name, a);
    else
      attrs.set(name, {
        domain: 'POINT',
        type: a.type,
        data: interpArray(a.data, dataComps(a.type), interp, a.type),
      });
  }
  const curves = new CurvesComponent(new Float32Array(pos), Uint32Array.from(offs), c.cyclic, attrs, c.materials);
  // Bézier ends: the tangent follows the handle (stored for the normal/tangent fields)
  endTangentOverrides.set(curves, bezierEndTangents(c, types, left, right, Uint32Array.from(offs)));
  return { curves, controlIndex, sameAsControl: false };
}

function bezierEndTangents(c: CurvesComponent, types: Int32Array | null, left: Float32Array, right: Float32Array, evOffs: Uint32Array): Float32Array {
  const out = new Float32Array(c.curveCount * 6).fill(NaN);
  if (!types) return out;
  const P = c.positions;
  for (let k = 0; k < c.curveCount; k++) {
    if (types[k] !== CT.BEZIER || c.cyclic[k]) continue;
    const s = c.curveOffsets[k],
      e = c.curveOffsets[k + 1];
    if (e - s < 2 || evOffs[k + 1] - evOffs[k] < 2) continue;
    const d0 = [right[s * 3] - P[s * 3], right[s * 3 + 1] - P[s * 3 + 1], right[s * 3 + 2] - P[s * 3 + 2]];
    const l0 = Math.hypot(d0[0], d0[1], d0[2]);
    if (l0 > 1e-9) out.set([d0[0] / l0, d0[1] / l0, d0[2] / l0], k * 6);
    const l = e - 1;
    const d1 = [P[l * 3] - left[l * 3], P[l * 3 + 1] - left[l * 3 + 1], P[l * 3 + 2] - left[l * 3 + 2]];
    const l1 = Math.hypot(d1[0], d1[1], d1[2]);
    if (l1 > 1e-9) out.set([d1[0] / l1, d1[1] / l1, d1[2] / l1], k * 6 + 3);
  }
  return out;
}

/** Tangents of evaluated points (Bézier curve ends follow their handles). */
export const evaluatedTangents = (ev: CurvesComponent): Float32Array => curveTangents(ev);

export function evaluatedNormals(ev: CurvesComponent, T = evaluatedTangents(ev)): Float32Array {
  return curveNormals(ev, T);
}

/**
 * Values computed on evaluated points, read back on control points: exact for poly, Bézier and
 * Catmull-Rom curves; NURBS control points use the value computed on the control polygon.
 */
export function onControlPoints(c: CurvesComponent, comps: number, onEvaluated: (ev: CurvesComponent) => Float32Array, onControl: (c: CurvesComponent) => Float32Array): Float32Array {
  const r = evaluateCurves(c);
  const evVals = onEvaluated(r.curves);
  if (r.sameAsControl) return evVals;
  const out = new Float32Array(c.pointCount * comps);
  let fallback: Float32Array | null = null;
  for (let i = 0; i < c.pointCount; i++) {
    const j = r.controlIndex[i];
    if (j >= 0) for (let k = 0; k < comps; k++) out[i * comps + k] = evVals[j * comps + k];
    else {
      if (!fallback) {
        const poly = c.copy();
        poly.attrs = new Map(c.attrs);
        poly.attrs.delete('curve_type');
        fallback = onControl(poly);
      }
      for (let k = 0; k < comps; k++) out[i * comps + k] = fallback[i * comps + k];
    }
  }
  return out;
}

/** Copy of a component with fresh attribute arrays for the given names (for in-place edits). */
export function editable(c: CurvesComponent): CurvesComponent {
  const out = c.copy();
  return out;
}

// ---------------------------------------------------------------------------
// Construction

export interface CurveSpec {
  points: number[][];
  cyclic?: boolean;
  type?: number;
  resolution?: number;
  left?: number[][];
  right?: number[][];
  typeLeft?: number;
  typeRight?: number;
}

/** Curves component from a list of curve descriptions (radius 1). */
export function buildCurves(list: CurveSpec[]): CurvesComponent {
  let total = 0;
  for (const s of list) total += s.points.length;
  const pos = new Float32Array(total * 3);
  const offs = new Uint32Array(list.length + 1),
    cyc = new Uint8Array(list.length);
  const types = new Int32Array(list.length),
    res = new Int32Array(list.length);
  const anyBez = list.some((s) => s.type === CT.BEZIER);
  const left = anyBez ? new Float32Array(total * 3) : null,
    right = anyBez ? new Float32Array(total * 3) : null;
  const tl = anyBez ? new Int32Array(total) : null,
    tr = anyBez ? new Int32Array(total) : null;
  let o = 0;
  list.forEach((s, k) => {
    offs[k] = o;
    cyc[k] = s.cyclic ? 1 : 0;
    types[k] = s.type ?? CT.POLY;
    res[k] = s.resolution ?? DEFAULT_RESOLUTION;
    s.points.forEach((p, i) => {
      pos.set(p, (o + i) * 3);
      if (left && right && tl && tr) {
        left.set(s.left?.[i] ?? p, (o + i) * 3);
        right.set(s.right?.[i] ?? p, (o + i) * 3);
        tl[o + i] = s.typeLeft ?? HT.FREE;
        tr[o + i] = s.typeRight ?? HT.FREE;
      }
    });
    o += s.points.length;
  });
  offs[list.length] = o;
  const attrs: AttrMap = new Map();
  attrs.set('radius', {
    domain: 'POINT',
    type: 'FLOAT',
    data: new Float32Array(total).fill(1),
  });
  if (types.some((t) => t !== CT.POLY)) setCurveAttr(attrs, 'curve_type', 'INT8', types);
  if (list.some((s) => s.resolution !== undefined)) setCurveAttr(attrs, 'resolution', 'INT', res);
  if (left && right && tl && tr) writeHandles({ attrs } as CurvesComponent, { left, right, tl, tr });
  return new CurvesComponent(pos, offs, cyc, attrs);
}

// ---------------------------------------------------------------------------
// Hooks used by generic geometry operations

/** Fill a built-in curve attribute that a joined component lacks; false when not built in. */
export function missingCurveAttr(c: CurvesComponent, name: string, data: AttrArray, o: number, n: number): boolean {
  if (name in CURVE_ATTR_DEFAULTS) {
    data.fill(CURVE_ATTR_DEFAULTS[name], o, o + n);
    return true;
  }
  if (name === 'handle_left' || name === 'handle_right') {
    data.set(c.positions.subarray(0, n * 3), o * 3);
    return true;
  }
  return false;
}

/** Transform handle positions and custom normals along with the control points. */
export function transformCurveAttrs(c: CurvesComponent, m: ArrayLike<number>) {
  for (const name of ['handle_left', 'handle_right']) {
    const a = c.attrs.get(name);
    if (!a || a.type !== 'FLOAT_VECTOR') continue;
    const src = a.data as Float32Array;
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      const x = src[i],
        y = src[i + 1],
        z = src[i + 2];
      out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
      out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    c.attrs.set(name, { ...a, data: out });
  }
  const cn = c.attrs.get('custom_normal');
  if (cn && cn.type === 'FLOAT_VECTOR') {
    const src = cn.data as Float32Array;
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      const x = src[i],
        y = src[i + 1],
        z = src[i + 2];
      const a = m[0] * x + m[4] * y + m[8] * z,
        b = m[1] * x + m[5] * y + m[9] * z,
        d = m[2] * x + m[6] * y + m[10] * z;
      const l = Math.hypot(a, b, d) || 1;
      out[i] = a / l;
      out[i + 1] = b / l;
      out[i + 2] = d / l;
    }
    c.attrs.set('custom_normal', { ...cn, data: out });
  }
}

/** Evaluated curves plus per-control-point values interpolated onto the evaluated points. */
export function evaluatedWithPointValues(c: CurvesComponent, values: Float32Array): { curves: CurvesComponent; values: Float32Array } {
  if (isPolyOnly(c)) return { curves: evaluatedCurves(c), values };
  const tmp = c.copy();
  const key = '#__eval_values';
  tmp.attrs.set(key, { domain: 'POINT', type: 'FLOAT', data: values });
  const ev = evaluatedCurves(tmp);
  const out = ev.attrs.get(key)!.data as Float32Array;
  const curves = ev.copy();
  curves.attrs.delete(key);
  const ends = endTangentOverrides.get(ev);
  if (ends) endTangentOverrides.set(curves, ends);
  return { curves, values: out };
}

// ---------------------------------------------------------------------------
// Control point fields (tangent, normal, length along the curve)

/** Copy of a component treated as poly curves (the control polygon). */
function asPoly(c: CurvesComponent): CurvesComponent {
  const p = c.copy();
  p.attrs.delete('curve_type');
  return p;
}

export function controlTangents(c: CurvesComponent): Float32Array {
  return onControlPoints(
    c,
    3,
    (ev) => curveTangents(ev),
    (p) => curveTangents(p),
  );
}

export function controlNormals(c: CurvesComponent): Float32Array {
  return onControlPoints(
    c,
    3,
    (ev) => curveNormals(ev, curveTangents(ev)),
    (p) => curveNormals(p),
  );
}

/** Distance along the curve of each control point and the length of each curve. */
export function controlLengths(c: CurvesComponent): {
  segment: Float32Array;
  total: Float32Array;
} {
  const r = evaluateCurves(c);
  if (r.sameAsControl) return curveLengths(c);
  const ev = curveLengths(r.curves);
  const types = curveTypes(c);
  const poly = types && types.some((t) => t === CT.NURBS) ? curveLengths(asPoly(c)) : null;
  const segment = new Float32Array(c.pointCount),
    total = new Float32Array(c.curveCount);
  for (let k = 0; k < c.curveCount; k++) {
    const nurbs = poly && types![k] === CT.NURBS;
    total[k] = nurbs ? poly.total[k] : ev.total[k];
    for (let i = c.curveOffsets[k]; i < c.curveOffsets[k + 1]; i++) {
      const j = r.controlIndex[i];
      segment[i] = nurbs || j < 0 ? (poly ? poly.segment[i] : 0) : ev.segment[j];
    }
  }
  return { segment, total };
}
