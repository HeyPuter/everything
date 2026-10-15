// Curve operation nodes: Reverse Curve, Subdivide Curve, Trim Curve.
import { gn, prop, sprop } from './defs';
import { evalOn } from '../nodes/common';
import { type CurvesComponent } from '../geometry';
import { curveLengths } from '../curveutil';
import { joinCurves } from '../ops/join';
import { CT, HT, bezierPoint, catmullWeights, curveTypes, evaluateCurves, handleData, pointInts, pointVectors, recalcHandles, writeHandles } from './curvedata';
import { assembleCurves, lerp3, P3, type OutCurve } from './assemble';
import { place } from './menu';

// ---------------------------------------------------------------------------
// Segment helpers

/** Split a cubic Bézier at t: [left part, right part] (4 points each). */
export function splitBezier(p0: number[], p1: number[], p2: number[], p3: number[], t: number): [number[][], number[][]] {
  const a = lerp3(p0, p1, t),
    b = lerp3(p1, p2, t),
    c = lerp3(p2, p3, t);
  const d = lerp3(a, b, t),
    e = lerp3(b, c, t);
  const m = lerp3(d, e, t);
  return [
    [p0, a, d, m],
    [m, e, c, p3],
  ];
}

export interface CurveCtx {
  c: CurvesComponent;
  types: Int32Array | null;
  left: Float32Array;
  right: Float32Array;
  tl: Int32Array;
  tr: Int32Array;
}

export function curveCtx(c: CurvesComponent): CurveCtx {
  return {
    c,
    types: curveTypes(c),
    left: pointVectors(c, 'handle_left', c.positions),
    right: pointVectors(c, 'handle_right', c.positions),
    tl: pointInts(c, 'handle_type_left', HT.FREE),
    tr: pointInts(c, 'handle_type_right', HT.FREE),
  };
}

const typeOf = (x: CurveCtx, k: number) => (x.types ? x.types[k] : CT.POLY);

/** Control points of segment q of curve k (wrapping for cyclic curves). */
function segPoints(x: CurveCtx, k: number, q: number): [number, number] {
  const s = x.c.curveOffsets[k],
    n = x.c.curveOffsets[k + 1] - s;
  return [s + (q % n), s + ((q + 1) % n)];
}

/** Position on segment q of curve k at parameter t. */
export function segPoint(x: CurveCtx, k: number, q: number, t: number): number[] {
  const P = x.c.positions;
  const [a, b] = segPoints(x, k, q);
  const type = typeOf(x, k);
  if (type === CT.BEZIER) {
    const out = [0, 0, 0];
    bezierPoint(P, a * 3, x.right, a * 3, x.left, b * 3, P, b * 3, t, out, 0);
    return out;
  }
  if (type === CT.CATMULL_ROM) {
    const s = x.c.curveOffsets[k],
      e = x.c.curveOffsets[k + 1],
      n = e - s;
    const cyc = !!x.c.cyclic[k];
    const at = (i: number) => (cyc ? s + ((((i - s) % n) + n) % n) : Math.min(e - 1, Math.max(s, i)));
    const i1 = s + q;
    const ids = [at(i1 - 1), at(i1), at(i1 + 1), at(i1 + 2)];
    const w = catmullWeights(t);
    const out = [0, 0, 0];
    for (let m = 0; m < 4; m++) for (let k2 = 0; k2 < 3; k2++) out[k2] += P[ids[m] * 3 + k2] * w[m];
    return out;
  }
  return lerp3(P3(P, a), P3(P, b), t);
}

function bezierSeg(x: CurveCtx, k: number, q: number): number[][] {
  const [a, b] = segPoints(x, k, q);
  return [P3(x.c.positions, a), P3(x.right, a), P3(x.left, b), P3(x.c.positions, b)];
}

/** Convert the masked NURBS curves to poly curves of their evaluated points. */
function nurbsToEvaluatedPoly(c: CurvesComponent, mask: (k: number) => boolean): CurvesComponent {
  const types = curveTypes(c);
  if (!types || !types.some((t, k) => t === CT.NURBS && mask(k))) return c;
  const ev = evaluateCurves(c).curves;
  const both = joinCurves([c, ev]);
  const outs: OutCurve[] = [];
  for (let k = 0; k < c.curveCount; k++) {
    const conv = types[k] === CT.NURBS && mask(k);
    const s = conv ? c.pointCount + ev.curveOffsets[k] : c.curveOffsets[k],
      e = conv ? c.pointCount + ev.curveOffsets[k + 1] : c.curveOffsets[k + 1];
    const o: OutCurve = { src: [], pos: [], type: conv ? CT.POLY : types[k], cyclic: !!c.cyclic[k] };
    for (let i = s; i < e; i++) {
      o.src.push(i);
      o.pos.push(both.positions[i * 3], both.positions[i * 3 + 1], both.positions[i * 3 + 2]);
    }
    outs.push(o);
  }
  return assembleCurves(both, outs);
}

// ---------------------------------------------------------------------------
// Reverse

export function reverseCurves(c: CurvesComponent, sel: Uint8Array | null): CurvesComponent {
  const x = curveCtx(c);
  const outs: OutCurve[] = [];
  const P = c.positions;
  for (let k = 0; k < c.curveCount; k++) {
    const s = c.curveOffsets[k],
      e = c.curveOffsets[k + 1];
    const flip = !sel || !!sel[k];
    const o: OutCurve = { src: [], pos: [], left: [], right: [], tl: [], tr: [], type: typeOf(x, k) };
    for (let j = s; j < e; j++) {
      const i = flip ? e - 1 - (j - s) : j;
      o.src.push(i);
      o.pos.push(...P3(P, i));
      o.left!.push(...P3(flip ? x.right : x.left, i));
      o.right!.push(...P3(flip ? x.left : x.right, i));
      o.tl!.push(flip ? x.tr[i] : x.tl[i]);
      o.tr!.push(flip ? x.tl[i] : x.tr[i]);
    }
    outs.push(o);
  }
  return assembleCurves(c, outs);
}

gn('GeometryNodeReverseCurve', 'geometry', {
  exec: (ctx) => {
    const g = ctx.geometry('Curve');
    if (!g.curves) return { Curve: g };
    const sel = evalOn(g.curves, 'CURVE', ctx.field('Selection', 'BOOLEAN'), []).sel;
    return { Curve: g.with(reverseCurves(g.curves, sel)) };
  },
});

// ---------------------------------------------------------------------------
// Subdivide

/** Handle type after its handle was moved by a split: auto → aligned, vector → free. */
const splitType = (t: number) => (t === HT.AUTO ? HT.ALIGN : t === HT.VECTOR ? HT.FREE : t);

export function subdivideCurves(c: CurvesComponent, cuts: Int32Array): CurvesComponent {
  const x = curveCtx(c);
  const P = c.positions;
  const outs: OutCurve[] = [];
  for (let k = 0; k < c.curveCount; k++) {
    const s = c.curveOffsets[k],
      e = c.curveOffsets[k + 1],
      n = e - s;
    const cyc = !!c.cyclic[k];
    const type = typeOf(x, k);
    const bez = type === CT.BEZIER;
    const o: OutCurve = { src: [], srcB: [], w: [], pos: [], left: [], right: [], tl: [], tr: [], type };
    const push = (a: number, b: number, t: number, p: number[], l: number[], r: number[], tl: number, tr: number) => {
      o.src.push(a);
      o.srcB!.push(b);
      o.w!.push(t);
      o.pos.push(...p);
      o.left!.push(...l);
      o.right!.push(...r);
      o.tl!.push(tl);
      o.tr!.push(tr);
    };
    const segs = cyc ? n : n - 1;
    // left handle of the next original point, possibly replaced by a split
    let nextLeft: number[] | null = null,
      nextTL = -1;
    for (let q = 0; q < n; q++) {
      const a = s + q;
      const m = q < segs ? Math.max(0, cuts[a]) : 0;
      let la = nextLeft ?? P3(x.left, a),
        ra = P3(x.right, a);
      let tla = nextTL >= 0 ? nextTL : x.tl[a],
        tra = x.tr[a];
      nextLeft = null;
      nextTL = -1;
      if (!m || q >= segs) {
        push(a, a, 0, P3(P, a), la, ra, tla, tra);
        continue;
      }
      const b = q + 1 < n ? a + 1 : s;
      if (bez && !(x.tr[a] === HT.VECTOR && x.tl[b] === HT.VECTOR)) {
        // repeated de Casteljau splits at uniform parameters
        let seg = bezierSeg(x, k, q);
        let done = 0;
        const parts: number[][][] = [];
        for (let j = 1; j <= m; j++) {
          const t = j / (m + 1);
          const [l, r] = splitBezier(seg[0], seg[1], seg[2], seg[3], (t - done) / (1 - done));
          parts.push(l);
          seg = r;
          done = t;
        }
        ra = parts[0][1];
        tra = splitType(tra);
        push(a, a, 0, P3(P, a), la, ra, tla, tra);
        for (let j = 0; j < m; j++) {
          const nextPart = j + 1 < m ? parts[j + 1] : seg;
          push(a, b, (j + 1) / (m + 1), parts[j][3], parts[j][2], nextPart[1], HT.ALIGN, HT.ALIGN);
        }
        nextLeft = seg[2];
        nextTL = splitType(x.tl[b]);
        if (b === s) {
          // closing segment of a cyclic curve: update the first point
          o.left!.splice(0, 3, ...seg[2]);
          o.tl![0] = nextTL;
          nextLeft = null;
          nextTL = -1;
        }
        continue;
      }
      push(a, a, 0, P3(P, a), la, ra, tla, tra);
      for (let j = 1; j <= m; j++) {
        const t = j / (m + 1);
        const p = type === CT.CATMULL_ROM ? segPoint(x, k, q, t) : lerp3(P3(P, a), P3(P, b), t);
        push(a, b, t, p, p, p, bez ? HT.VECTOR : HT.FREE, bez ? HT.VECTOR : HT.FREE);
      }
    }
    outs.push(o);
  }
  const out = assembleCurves(c, outs);
  const types = curveTypes(out);
  if (types && types.some((t) => t === CT.BEZIER)) {
    // auto and vector handles follow their new neighbours
    const hd = handleData(out);
    recalcHandles(out.positions, out.curveOffsets, out.cyclic, types, hd.left, hd.right, hd.tl, hd.tr, false);
    writeHandles(out, hd);
  }
  return out;
}

gn('GeometryNodeSubdivideCurve', 'geometry', {
  exec: (ctx) => {
    const g = ctx.geometry('Curve');
    if (!g.curves) return { Curve: g };
    const cuts = evalOn(g.curves, 'POINT', undefined, [ctx.field('Cuts', 'INT')]).values[0] as Int32Array;
    if (!cuts.some((v) => v > 0)) return { Curve: g };
    return { Curve: g.with(subdivideCurves(g.curves, cuts)) };
  },
});

// ---------------------------------------------------------------------------
// Trim

/** Control segment and parameter at a distance along curve k (lengths of the evaluated curve). */
function locateParam(c: CurvesComponent, k: number, len: number, segLen: Float32Array, total: number, ctrlIdx: Int32Array, evOffs: Uint32Array): [number, number] {
  const s = c.curveOffsets[k],
    n = c.curveOffsets[k + 1] - s;
  const es = evOffs[k],
    ee = evOffs[k + 1];
  const cyc = !!c.cyclic[k];
  const segs = cyc ? n : n - 1;
  if (segs <= 0) return [0, 0];
  const d = Math.max(0, Math.min(total, len));
  // evaluated point j with segLen[j] ≤ d
  let lo = es,
    hi = ee - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segLen[mid] <= d) lo = mid;
    else hi = mid - 1;
  }
  const j = lo;
  const nextLen = j + 1 < ee ? segLen[j + 1] : total;
  const f = nextLen > segLen[j] ? Math.min(1, (d - segLen[j]) / (nextLen - segLen[j])) : 0;
  // control segment containing evaluated point j
  let q = 0;
  while (q + 1 < segs && ctrlIdx[s + q + 1] <= j) q++;
  const start = ctrlIdx[s + q];
  const end = q + 1 < n ? ctrlIdx[s + q + 1] : ee;
  const count = Math.max(1, end - start);
  let t = (j - start + f) / count;
  if (!cyc && j >= ee - 1) {
    q = segs - 1;
    t = 1;
  }
  return [q, Math.max(0, Math.min(1, t))];
}

/** Handle type of a kept point whose handle was cut: free unless both sides were the same kind. */
const cutType = (t: number, other: number) => ((t === HT.AUTO || t === HT.VECTOR) && t !== other ? HT.FREE : t);

export function trimCurves(c0: CurvesComponent, sel: Uint8Array | null, start: Float32Array, end: Float32Array, byLength: boolean): CurvesComponent {
  const c = nurbsToEvaluatedPoly(c0, (k) => !sel || !!sel[k]);
  const x = curveCtx(c);
  const r = evaluateCurves(c);
  const lens = curveLengths(r.curves);
  const P = c.positions;
  const outs: OutCurve[] = [];
  for (let k = 0; k < c.curveCount; k++) {
    const s = c.curveOffsets[k],
      e = c.curveOffsets[k + 1],
      n = e - s;
    const cyc = !!c.cyclic[k];
    const type = typeOf(x, k);
    const o: OutCurve = { src: [], srcB: [], w: [], pos: [], left: [], right: [], tl: [], tr: [], type };
    const push = (a: number, b: number, t: number, p: number[], l: number[], rr: number[], tl: number, tr: number) => {
      o.src.push(a);
      o.srcB!.push(b);
      o.w!.push(t);
      o.pos.push(...p);
      o.left!.push(...l);
      o.right!.push(...rr);
      o.tl!.push(tl);
      o.tr!.push(tr);
    };
    const keepAll = () => {
      for (let i = s; i < e; i++) push(i, i, 0, P3(P, i), P3(x.left, i), P3(x.right, i), x.tl[i], x.tr[i]);
    };
    if ((sel && !sel[k]) || n < 2) {
      keepAll();
      outs.push(o);
      continue;
    }
    o.cyclic = false;
    const total = lens.total[k];
    let a0 = byLength ? start[k] : start[k] * total,
      a1 = byLength ? end[k] : end[k] * total;
    a0 = Math.max(0, Math.min(total, a0));
    a1 = Math.max(0, Math.min(total, a1));
    const segs = cyc ? n : n - 1;
    let [q0, t0] = locateParam(c, k, a0, lens.segment, total, r.controlIndex, r.curves.curveOffsets);
    let [q1, t1] = locateParam(c, k, a1, lens.segment, total, r.controlIndex, r.curves.curveOffsets);
    const wrap = cyc && a0 > a1;
    if (!cyc && a0 >= a1) {
      q1 = q0;
      t1 = t0;
    }
    // avoid duplicates at control points
    if (t0 >= 1 - 1e-6 && (cyc || q0 < segs - 1) && !(q0 === q1 && !wrap)) {
      q0 = (q0 + 1) % segs;
      t0 = 0;
    }
    let q1u = q1 + (wrap || (cyc && q1 < q0) ? segs : 0);
    if (t1 <= 1e-6 && q1u > q0) {
      q1u--;
      t1 = 1;
    }
    const single = !cyc && a0 >= a1;
    const ends0 = segPoints(x, k, q0);
    const S = segPoint(x, k, q0, t0);
    const bez = type === CT.BEZIER;
    if (single) {
      let l = P3(P, ends0[0]),
        rr = l;
      if (bez) {
        const [lp, rp] = splitBezier(...(bezierSeg(x, k, q0) as [number[], number[], number[], number[]]), t0);
        l = lp[2];
        rr = rp[1];
      }
      push(ends0[0], ends0[1], t0, S, l, rr, x.tl[ends0[0]], x.tr[ends0[0]]);
      outs.push(o);
      continue;
    }
    const q1m = q1u % segs;
    const ends1 = segPoints(x, k, q1m);
    const E = segPoint(x, k, q1m, t1);
    // kept control points: starts of segments q0+1 .. q1u
    const kept: number[] = [];
    for (let q = q0 + 1; q <= q1u; q++) kept.push(s + (q % n));
    let sL = P3(P, ends0[0]),
      sR = sL,
      eL = P3(P, ends1[1]),
      eR = eL;
    const keptL = kept.map((i) => P3(x.left, i)),
      keptR = kept.map((i) => P3(x.right, i));
    const keptTL = kept.map((i) => x.tl[i]),
      keptTR = kept.map((i) => x.tr[i]);
    if (bez) {
      const seg0 = bezierSeg(x, k, q0) as [number[], number[], number[], number[]];
      const seg1 = bezierSeg(x, k, q1m) as [number[], number[], number[], number[]];
      if (!kept.length) {
        // both ends on one segment: the part between t0 and t1
        const [l1, r1] = splitBezier(...seg0, t1);
        const [l0] = splitBezier(...seg0, t0);
        const sub = t1 > 0 ? splitBezier(l1[0], l1[1], l1[2], l1[3], t0 / t1)[1] : [S, S, S, S];
        sL = l0[2];
        sR = sub[1];
        eL = sub[2];
        eR = r1[1];
      } else {
        const [l0, r0] = splitBezier(...seg0, t0);
        sL = l0[2];
        sR = r0[1];
        keptL[0] = r0[2];
        keptTL[0] = cutType(keptTL[0], keptTR[0]);
        const [l1, r1] = splitBezier(...seg1, t1);
        const last = kept.length - 1;
        keptR[last] = l1[1];
        keptTR[last] = cutType(keptTR[last], keptTL[last]);
        eL = l1[2];
        eR = r1[1];
      }
    }
    push(ends0[0], ends0[1], t0, S, sL, sR, x.tl[ends0[0]], x.tr[ends0[0]]);
    kept.forEach((i, j) => push(i, i, 0, P3(P, i), keptL[j], keptR[j], keptTL[j], keptTR[j]));
    push(ends1[0], ends1[1], t1, E, eL, eR, x.tl[ends1[1]], x.tr[ends1[1]]);
    outs.push(o);
  }
  return assembleCurves(c, outs);
}

gn(
  'GeometryNodeTrimCurve',
  'geometry',
  {
    exec: (ctx) => {
      const g = ctx.geometry('Curve');
      if (!g.curves) return { Curve: g };
      const byLength = sprop(ctx.node, 'mode') === 'LENGTH';
      const r = evalOn(g.curves, 'CURVE', ctx.field('Selection', 'BOOLEAN'), [ctx.field(byLength ? 'Start_001' : 'Start', 'FLOAT'), ctx.field(byLength ? 'End_001' : 'End', 'FLOAT')]);
      return { Curve: g.with(trimCurves(g.curves, r.sel, r.values[0] as Float32Array, r.values[1] as Float32Array, byLength)) };
    },
  },
  {
    available: (n, s) => {
      const len = sprop(n, 'mode') === 'LENGTH';
      if (s.identifier === 'Start' || s.identifier === 'End') return !len;
      if (s.identifier === 'Start_001' || s.identifier === 'End_001') return len;
      return true;
    },
    propPatch: { mode: { expand: true } },
  },
);

place('Curve/Operations', 'GeometryNodeReverseCurve');
place('Curve/Operations', 'GeometryNodeSubdivideCurve');
place('Curve/Operations', 'GeometryNodeTrimCurve');

// ---------------------------------------------------------------------------
// Fillet

const sub3 = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len3 = (a: number[]) => Math.hypot(a[0], a[1], a[2]);
const scale3 = (a: number[], s: number) => [a[0] * s, a[1] * s, a[2] * s];
const add3 = (a: number[], b: number[]) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const norm3 = (a: number[]) => {
  const l = len3(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function filletCurves(c: CurvesComponent, radius: Float32Array, count: Int32Array, bezierMode: boolean, limit: boolean): CurvesComponent {
  const x = curveCtx(c);
  const P = c.positions;
  const outs: OutCurve[] = [];
  for (let k = 0; k < c.curveCount; k++) {
    const s = c.curveOffsets[k],
      e = c.curveOffsets[k + 1],
      n = e - s;
    const cyc = !!c.cyclic[k];
    const type = typeOf(x, k);
    const o: OutCurve = { src: [], pos: [], left: [], right: [], tl: [], tr: [], type };
    const push = (src: number, p: number[], l: number[], r: number[], tl: number, tr: number) => {
      o.src.push(src);
      o.pos.push(...p);
      o.left!.push(...l);
      o.right!.push(...r);
      o.tl!.push(tl);
      o.tr!.push(tr);
    };
    // corner geometry and tangent distances
    const corner: ({ a: number[]; b: number[]; theta: number; d: number } | null)[] = [];
    for (let j = 0; j < n; j++) {
      const i = s + j;
      if (n < 3 || (!cyc && (j === 0 || j === n - 1)) || radius[i] <= 0) {
        corner.push(null);
        continue;
      }
      const p = P3(P, i),
        prev = P3(P, j > 0 ? i - 1 : e - 1),
        next = P3(P, j < n - 1 ? i + 1 : s);
      const da = sub3(prev, p),
        db = sub3(next, p);
      if (len3(da) < 1e-9 || len3(db) < 1e-9) {
        corner.push(null);
        continue;
      }
      const a = norm3(da),
        b = norm3(db);
      const theta = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
      if (theta < 1e-6 || theta > Math.PI - 1e-6) {
        corner.push(null);
        continue;
      }
      corner.push({ a, b, theta, d: radius[i] / Math.tan(theta / 2) });
    }
    if (limit) {
      const dist = corner.map((cn) => cn?.d ?? 0);
      const limited = dist.slice();
      const segs = cyc ? n : n - 1;
      for (let q = 0; q < segs; q++) {
        const j0 = q,
          j1 = (q + 1) % n;
        const L = len3(sub3(P3(P, s + j1), P3(P, s + j0)));
        const sum = dist[j0] + dist[j1];
        if (sum > L && sum > 0) {
          limited[j0] = Math.min(limited[j0], (L * dist[j0]) / sum);
          limited[j1] = Math.min(limited[j1], (L * dist[j1]) / sum);
        }
      }
      corner.forEach((cn, j) => {
        if (cn) cn.d = limited[j];
      });
    }
    for (let j = 0; j < n; j++) {
      const i = s + j;
      const cn = corner[j];
      const p = P3(P, i);
      if (!cn) {
        push(i, p, P3(x.left, i), P3(x.right, i), x.tl[i], x.tr[i]);
        continue;
      }
      const { a, b, theta, d } = cn;
      const r = d * Math.tan(theta / 2);
      const t1 = add3(p, scale3(a, d)),
        t2 = add3(p, scale3(b, d));
      if (bezierMode) {
        if (type === CT.BEZIER) {
          const h = (4 / 3) * Math.tan((Math.PI - theta) / 4) * r;
          push(i, t1, t1, sub3(t1, scale3(a, h)), HT.VECTOR, HT.ALIGN);
          push(i, t2, sub3(t2, scale3(b, h)), t2, HT.ALIGN, HT.VECTOR);
        } else {
          push(i, t1, t1, t1, HT.FREE, HT.FREE);
          push(i, t2, t2, t2, HT.FREE, HT.FREE);
        }
        continue;
      }
      // arc points around the fillet center
      const m = Math.max(1, count[i]);
      const bis = norm3(add3(a, b));
      const center = add3(p, scale3(bis, r / Math.sin(theta / 2)));
      const u = sub3(t1, center),
        v = sub3(t2, center);
      const phi = Math.PI - theta;
      for (let q = 0; q <= m; q++) {
        const f = q / m;
        // slerp between the two radius vectors
        const w1 = Math.sin((1 - f) * phi) / Math.sin(phi),
          w2 = Math.sin(f * phi) / Math.sin(phi);
        const pt = add3(center, add3(scale3(u, w1), scale3(v, w2)));
        push(i, pt, pt, pt, HT.VECTOR, HT.VECTOR);
      }
    }
    outs.push(o);
  }
  const out = assembleCurves(c, outs);
  const types = curveTypes(out);
  if (types && types.some((t) => t === CT.BEZIER)) {
    const hd = handleData(out);
    recalcHandles(out.positions, out.curveOffsets, out.cyclic, types, hd.left, hd.right, hd.tl, hd.tr, false);
    writeHandles(out, hd);
  }
  return out;
}

gn(
  'GeometryNodeFilletCurve',
  'geometry',
  {
    exec: (ctx) => {
      const g = ctx.geometry('Curve');
      if (!g.curves) return { Curve: g };
      const bezier = String(ctx.prop('Mode')) !== 'Poly';
      const r = evalOn(g.curves, 'POINT', undefined, [ctx.field('Radius', 'FLOAT'), ctx.field('Count', 'INT')]);
      return { Curve: g.with(filletCurves(g.curves, r.values[0] as Float32Array, r.values[1] as Int32Array, bezier, ctx.bool('Limit Radius'))) };
    },
  },
  {
    menus: {
      Mode: [
        ['Bézier', 'Bézier'],
        ['Poly', 'Poly'],
      ],
    },
    available: (n, s) => (s.identifier === 'Count' ? prop(n, 'Mode') === 'Poly' : true),
  },
);

place('Curve/Operations', 'GeometryNodeFilletCurve');
