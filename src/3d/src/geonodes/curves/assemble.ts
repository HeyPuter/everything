// Building curves components from per-curve point lists: point attributes are gathered from a
// source point, or interpolated between two source points.
import { CurvesComponent, gatherArray, type AttrMap } from '../geometry';
import { dataComps, type AttrArray } from '../types';
import { CT, DEFAULT_ORDER, HT, KNOTS, curveInts, pointVectors, pruneTypeAttrs, setCurveAttr, setPointAttr } from './curvedata';

export interface OutCurve {
  /** source point per new point */
  src: number[];
  /** optional second source and weight: attributes are mixed src·(1−w) + srcB·w */
  srcB?: number[];
  w?: number[];
  pos: number[];
  left?: number[];
  right?: number[];
  tl?: number[];
  tr?: number[];
  type: number;
  cyclic?: boolean;
  knots?: number;
  order?: number;
}

export const P3 = (a: ArrayLike<number>, i: number) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
export const lerp3 = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const HANDLE_ATTRS = new Set(['handle_left', 'handle_right', 'handle_type_left', 'handle_type_right']);

function mixArray(data: AttrArray, comps: number, a: number[], b: number[], w: number[], type: string): AttrArray {
  const out = new (data.constructor as { new (n: number): AttrArray })(a.length * comps);
  const isBool = type === 'BOOLEAN',
    isInt = type === 'INT' || type === 'INT8';
  for (let i = 0; i < a.length; i++)
    for (let k = 0; k < comps; k++) {
      const t = w[i];
      if (isBool || isInt) out[i * comps + k] = t < 0.5 ? data[a[i] * comps + k] : data[b[i] * comps + k];
      else out[i * comps + k] = data[a[i] * comps + k] * (1 - t) + data[b[i] * comps + k] * t;
    }
  return out;
}

/** Build a new component (one output curve per input curve, curve attributes kept). */
export function assembleCurves(c: CurvesComponent, outs: OutCurve[]): CurvesComponent {
  const src: number[] = [],
    srcB: number[] = [],
    w: number[] = [],
    pos: number[] = [],
    offs: number[] = [0];
  let mixed = false;
  const oldL = pointVectors(c, 'handle_left', c.positions),
    oldR = pointVectors(c, 'handle_right', c.positions);
  const oldTL = c.attrs.get('handle_type_left')?.data,
    oldTR = c.attrs.get('handle_type_right')?.data;
  const L: number[] = [],
    R: number[] = [],
    TL: number[] = [],
    TR: number[] = [];
  outs.forEach((o) => {
    o.src.forEach((s, i) => {
      src.push(s);
      srcB.push(o.srcB ? o.srcB[i] : s);
      w.push(o.w ? o.w[i] : 0);
      if (o.w && o.w[i]) mixed = true;
      pos.push(o.pos[i * 3], o.pos[i * 3 + 1], o.pos[i * 3 + 2]);
      if (o.left && o.right) {
        L.push(o.left[i * 3], o.left[i * 3 + 1], o.left[i * 3 + 2]);
        R.push(o.right[i * 3], o.right[i * 3 + 1], o.right[i * 3 + 2]);
      } else {
        L.push(oldL[s * 3], oldL[s * 3 + 1], oldL[s * 3 + 2]);
        R.push(oldR[s * 3], oldR[s * 3 + 1], oldR[s * 3 + 2]);
      }
      TL.push(o.tl ? o.tl[i] : oldTL ? oldTL[s] : HT.FREE);
      TR.push(o.tr ? o.tr[i] : oldTR ? oldTR[s] : HT.FREE);
    });
    offs.push(src.length);
  });
  const attrs: AttrMap = new Map();
  for (const [name, a] of c.attrs) {
    if (a.domain === 'CURVE') attrs.set(name, a.data.length === outs.length * dataComps(a.type) ? a : { ...a, data: a.data.slice(0, outs.length * dataComps(a.type)) });
    else if (!HANDLE_ATTRS.has(name)) {
      const comps = dataComps(a.type);
      attrs.set(name, { ...a, data: mixed ? mixArray(a.data, comps, src, srcB, w, a.type) : gatherArray(a.data, comps, src) });
    }
  }
  const types = Int32Array.from(outs, (o) => o.type);
  setCurveAttr(attrs, 'curve_type', 'INT8', types);
  if (types.some((t) => t === CT.BEZIER)) {
    setPointAttr(attrs, 'handle_left', 'FLOAT_VECTOR', Float32Array.from(L));
    setPointAttr(attrs, 'handle_right', 'FLOAT_VECTOR', Float32Array.from(R));
    setPointAttr(attrs, 'handle_type_left', 'INT8', Int32Array.from(TL));
    setPointAttr(attrs, 'handle_type_right', 'INT8', Int32Array.from(TR));
  }
  if (types.some((t) => t === CT.NURBS)) {
    const knots = curveInts(c, 'knots_mode', KNOTS.NORMAL).slice(0, outs.length),
      order = curveInts(c, 'nurbs_order', DEFAULT_ORDER).slice(0, outs.length);
    outs.forEach((o, k) => {
      if (o.knots !== undefined) knots[k] = o.knots;
      if (o.order !== undefined) order[k] = o.order;
    });
    setCurveAttr(attrs, 'knots_mode', 'INT8', new Int32Array(knots));
    setCurveAttr(attrs, 'nurbs_order', 'INT8', new Int32Array(order));
  }
  const cyclic = Uint8Array.from(outs, (o, k) => (o.cyclic === undefined ? c.cyclic[k] : o.cyclic ? 1 : 0));
  const out = new CurvesComponent(Float32Array.from(pos), Uint32Array.from(offs), cyclic, attrs, c.materials);
  pruneTypeAttrs(out);
  return out;
}
