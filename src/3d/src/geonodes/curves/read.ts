// Curve reading nodes: Curve Tilt, Spline Resolution, Endpoint Selection, Handle Type
// Selection, Spline Length, Curve of Point, Points of Curve, Offset Point in Curve, Sample Curve.
import { gn, prop, sprop } from './defs';
import { InputField, allocField, evalFull, makeContext, type Evaluated, type Field, type FieldContext } from '../field';
import { adaptDomain, type CurvesComponent } from '../geometry';
import { fieldComps, fieldTypeOfEnum, dataTypeOfField, type FieldType } from '../types';
import { indexField, curveTangentField } from '../inputs';
import { realizeInstances } from '../ops/join';
import { valueSocket } from '../nodes/geometry';
import { curveLengths, curveNormals, curveTangents } from '../curveutil';
import { CT, HANDLE_TYPE_IDS, curveInts, curveTypes, evaluateCurves, pointFloats, pointInts } from './curvedata';
import { flagSet, sideToggles } from './write';
import { place } from './menu';

const full = (data: Evaluated['data']): Evaluated => ({ data, single: false });
const zero = (t: FieldType): Evaluated => ({ data: allocField(t, 1), single: true });

/** Field computed from the curves of the evaluation context (zero elsewhere). */
function curveField(t: FieldType, key: string, fn: (c: CurvesComponent, ctx: FieldContext) => Evaluated['data'] | null): Field {
  return new InputField(t, key, (ctx) => {
    if (ctx.comp.kind !== 'CURVES') return zero(t);
    const r = fn(ctx.comp, ctx);
    return r ? full(r) : zero(t);
  });
}

/** Values given on points or curves, read on the context domain. */
function onDomain(c: CurvesComponent, ctx: FieldContext, data: Evaluated['data'], from: 'POINT' | 'CURVE', t: FieldType) {
  if (ctx.domain === from) return data;
  if (ctx.domain !== 'POINT' && ctx.domain !== 'CURVE') return allocField(t, ctx.size);
  return adaptDomain(c, data, dataTypeOfField(t), from, ctx.domain);
}

// ---------------------------------------------------------------------------
// Inputs

gn('GeometryNodeInputCurveTilt', 'input', {
  exec: () => ({ Tilt: curveField('FLOAT', 'curve_tilt', (c, ctx) => onDomain(c, ctx, pointFloats(c, 'tilt', 0), 'POINT', 'FLOAT')) }),
});

gn('GeometryNodeInputSplineResolution', 'input', {
  exec: () => ({
    Resolution: curveField('INT', 'spline_resolution', (c, ctx) => onDomain(c, ctx, curveInts(c, 'resolution', 12), 'CURVE', 'INT')),
  }),
});

gn('GeometryNodeCurveEndpointSelection', 'input', {
  exec: (ctx) => {
    const startF = ctx.field('Start Size', 'INT'),
      endF = ctx.field('End Size', 'INT');
    return {
      Selection: curveField('BOOLEAN', `endpoints:${ctx.path}`, (c, fc) => {
        const cc = makeContext(c, 'CURVE');
        const st = evalFull(startF, cc),
          en = evalFull(endF, cc);
        const sel = new Uint8Array(c.pointCount);
        for (let k = 0; k < c.curveCount; k++) {
          const s = c.curveOffsets[k],
            e = c.curveOffsets[k + 1];
          for (let i = s; i < e; i++) if (i - s < st[k] || e - 1 - i < en[k]) sel[i] = 1;
        }
        return onDomain(c, fc, sel, 'POINT', 'BOOLEAN');
      }),
    };
  },
});

gn(
  'GeometryNodeCurveHandleTypeSelection',
  'input',
  {
    exec: (ctx) => {
      const type = HANDLE_TYPE_IDS.indexOf(String(prop(ctx.node, 'handle_type')) as never);
      const f = flagSet(ctx.node, 'mode');
      const left = f.has('LEFT'),
        right = f.has('RIGHT');
      return {
        Selection: curveField('BOOLEAN', `handle_sel:${type}:${left}:${right}`, (c, fc) => {
          const types = curveTypes(c);
          const sel = new Uint8Array(c.pointCount);
          if (types) {
            const tl = pointInts(c, 'handle_type_left', 0),
              tr = pointInts(c, 'handle_type_right', 0);
            const pc = c.pointCurve();
            for (let i = 0; i < c.pointCount; i++) if (types[pc[i]] === CT.BEZIER && ((left && tl[i] === type) || (right && tr[i] === type))) sel[i] = 1;
          }
          return onDomain(c, fc, sel, 'POINT', 'BOOLEAN');
        }),
      };
    },
  },
  {
    propPatch: { mode: { visible: () => false }, handle_type: { expand: true } },
    drawBody: sideToggles('mode'),
    bodyHeight: () => 26,
  },
);

gn('GeometryNodeSplineLength', 'input', {
  exec: () => ({
    Length: curveField('FLOAT', 'spline_length', (c, ctx) => onDomain(c, ctx, curveLengths(evaluateCurves(c).curves).total, 'CURVE', 'FLOAT')),
    'Point Count': curveField('INT', 'spline_point_count', (c, ctx) => {
      const n = new Int32Array(c.curveCount);
      for (let k = 0; k < c.curveCount; k++) n[k] = c.curveOffsets[k + 1] - c.curveOffsets[k];
      return onDomain(c, ctx, n, 'CURVE', 'INT');
    }),
  }),
});

// ---------------------------------------------------------------------------
// Topology

gn('GeometryNodeCurveOfPoint', 'input', {
  exec: (ctx) => {
    const pi = ctx.field('Point Index', 'INT');
    const make = (which: 'curve' | 'local') =>
      curveField('INT', `curve_of_point:${which}:${ctx.path}`, (c, fc) => {
        const idx = evalFull(pi, fc);
        const pc = c.pointCurve();
        const out = new Int32Array(fc.size);
        for (let i = 0; i < fc.size; i++) {
          const p = idx[i];
          if (p < 0 || p >= c.pointCount) continue;
          out[i] = which === 'curve' ? pc[p] : p - c.curveOffsets[pc[p]];
        }
        return out;
      });
    return { 'Curve Index': make('curve'), 'Index in Curve': make('local') };
  },
  implicit: { 'Point Index': indexField },
});

gn('GeometryNodePointsOfCurve', 'input', {
  exec: (ctx) => {
    const ci = ctx.field('Curve Index', 'INT'),
      wf = ctx.field('Weights', 'FLOAT'),
      si = ctx.field('Sort Index', 'INT');
    return {
      'Point Index': curveField('INT', `points_of_curve:${ctx.path}`, (c, fc) => {
        const curve = evalFull(ci, fc),
          sort = evalFull(si, fc);
        const w = evalFull(wf, makeContext(c, 'POINT'));
        const out = new Int32Array(fc.size);
        const sorted = new Map<number, number[]>();
        for (let i = 0; i < fc.size; i++) {
          const k = curve[i];
          if (k < 0 || k >= c.curveCount) continue;
          let order = sorted.get(k);
          if (!order) {
            order = [];
            for (let p = c.curveOffsets[k]; p < c.curveOffsets[k + 1]; p++) order.push(p);
            order.sort((a, b) => w[a] - w[b] || a - b);
            sorted.set(k, order);
          }
          if (!order.length) continue;
          const n = order.length;
          out[i] = order[(((sort[i] % n) + n) % n) as number];
        }
        return out;
      }),
      Total: curveField('INT', `points_of_curve_total:${ctx.path}`, (c, fc) => {
        const curve = evalFull(ci, fc);
        const out = new Int32Array(fc.size);
        for (let i = 0; i < fc.size; i++) {
          const k = curve[i];
          if (k >= 0 && k < c.curveCount) out[i] = c.curveOffsets[k + 1] - c.curveOffsets[k];
        }
        return out;
      }),
    };
  },
  implicit: { 'Curve Index': indexField },
});

gn('GeometryNodeOffsetPointInCurve', 'input', {
  exec: (ctx) => {
    const pi = ctx.field('Point Index', 'INT'),
      off = ctx.field('Offset', 'INT');
    const compute = (c: CurvesComponent, fc: FieldContext) => {
      const idx = evalFull(pi, fc),
        o = evalFull(off, fc);
      const pc = c.pointCurve();
      const valid = new Uint8Array(fc.size),
        res = new Int32Array(fc.size);
      for (let i = 0; i < fc.size; i++) {
        const p = idx[i];
        if (p < 0 || p >= c.pointCount) continue;
        const k = pc[p],
          s = c.curveOffsets[k],
          n = c.curveOffsets[k + 1] - s;
        const local = p - s + o[i];
        if (c.cyclic[k]) {
          res[i] = s + (((local % n) + n) % n);
          valid[i] = 1;
        } else if (local >= 0 && local < n) {
          res[i] = s + local;
          valid[i] = 1;
        } else res[i] = Math.max(0, Math.min(c.pointCount - 1, p + o[i]));
      }
      return { valid, res };
    };
    return {
      'Is Valid Offset': curveField('BOOLEAN', `offset_point_valid:${ctx.path}`, (c, fc) => compute(c, fc).valid),
      'Point Index': curveField('INT', `offset_point_index:${ctx.path}`, (c, fc) => compute(c, fc).res),
    };
  },
  implicit: { 'Point Index': indexField },
});

// ---------------------------------------------------------------------------
// Sample Curve

interface Sampler {
  ev: CurvesComponent;
  tangents: Float32Array;
  normals: Float32Array;
  lengths: { segment: Float32Array; total: Float32Array };
  values: Float32Array | Int32Array | Uint8Array | null;
  comps: number;
}

/** Locate a length along evaluated curve k: (point a, point b, t). */
function locate(s: Sampler, k: number, len: number): [number, number, number] | null {
  const ev = s.ev;
  const st = ev.curveOffsets[k],
    e = ev.curveOffsets[k + 1];
  if (e <= st) return null;
  const L = s.lengths.total[k];
  const d = Math.max(0, Math.min(L, len));
  const seg = s.lengths.segment;
  if (e - st === 1) return [st, st, 0];
  // binary search the last point whose distance is ≤ d
  let lo = st,
    hi = e - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (seg[mid] <= d) lo = mid;
    else hi = mid - 1;
  }
  const cyc = !!ev.cyclic[k];
  let a = lo,
    b = lo + 1;
  if (b >= e) {
    if (!cyc) return [e - 1, e - 1, 0];
    b = st;
  }
  const segLen = (b === st ? L : seg[b]) - seg[a];
  const t = segLen > 0 ? Math.max(0, Math.min(1, (d - seg[a]) / segLen)) : 0;
  return [a, b, t];
}

function makeSampler(c: CurvesComponent, valueF: Field | null, t: FieldType): Sampler {
  const comps = fieldComps(t);
  let values: Sampler['values'] = null;
  let src = c;
  if (valueF) {
    // values on control points, interpolated onto the evaluated points
    const data = evalFull(valueF, makeContext(c, 'POINT'));
    src = c.copy();
    src.attrs.set('#sample_value', { domain: 'POINT', type: dataTypeOfField(t), data });
  }
  const ev = evaluateCurves(src).curves;
  if (valueF) values = ev.attrs.get('#sample_value')!.data;
  const tangents = curveTangents(ev);
  return { ev, tangents, normals: curveNormals(ev, tangents), lengths: curveLengths(ev), values, comps };
}

const normalize3 = (out: Float32Array, i: number) => {
  const l = Math.hypot(out[i], out[i + 1], out[i + 2]);
  if (l > 1e-12) {
    out[i] /= l;
    out[i + 1] /= l;
    out[i + 2] /= l;
  }
};

gn(
  'GeometryNodeSampleCurve',
  'geometry',
  {
    exec: (ctx) => {
      const g = realizeInstances(ctx.geometry('Curves'));
      const t = fieldTypeOfEnum(prop(ctx.node, 'data_type'));
      const byLength = sprop(ctx.node, 'mode') === 'LENGTH';
      const all = !!prop(ctx.node, 'use_all_curves');
      const amountF = ctx.field(byLength ? 'Length' : 'Factor', 'FLOAT');
      const indexF = ctx.field('Curve Index', 'INT');
      const valueF = ctx.linked('Value') ? ctx.field('Value', t) : null;
      const c = g.curves;
      let sampler: Sampler | null = null;
      const get = () => (sampler ??= makeSampler(c!, valueF, t));
      const results = new WeakMap<FieldContext, { pos: Float32Array; tan: Float32Array; nor: Float32Array; val: Evaluated['data'] }>();
      const compute = (fc: FieldContext) => {
        let r = results.get(fc);
        if (r) return r;
        const n = fc.size;
        r = { pos: new Float32Array(n * 3), tan: new Float32Array(n * 3), nor: new Float32Array(n * 3), val: allocField(t, n) };
        results.set(fc, r);
        if (!c || !c.curveCount) return r;
        const s = get();
        const amount = evalFull(amountF, fc) as Float32Array;
        const index = all ? null : evalFull(indexF, fc);
        let grand = 0;
        if (all) for (const l of s.lengths.total) grand += l;
        const P = s.ev.positions;
        for (let i = 0; i < n; i++) {
          let k: number, len: number;
          if (all) {
            let d = byLength ? amount[i] : amount[i] * grand;
            d = Math.max(0, Math.min(grand, d));
            k = 0;
            while (k < c.curveCount - 1 && d > s.lengths.total[k]) {
              d -= s.lengths.total[k];
              k++;
            }
            len = d;
          } else {
            k = index![i];
            if (k < 0 || k >= c.curveCount) continue;
            len = byLength ? amount[i] : amount[i] * s.lengths.total[k];
          }
          const loc = locate(s, k, len);
          if (!loc) continue;
          const [a, b, w] = loc;
          for (let q = 0; q < 3; q++) {
            r.pos[i * 3 + q] = P[a * 3 + q] + (P[b * 3 + q] - P[a * 3 + q]) * w;
            r.tan[i * 3 + q] = s.tangents[a * 3 + q] + (s.tangents[b * 3 + q] - s.tangents[a * 3 + q]) * w;
            r.nor[i * 3 + q] = s.normals[a * 3 + q] + (s.normals[b * 3 + q] - s.normals[a * 3 + q]) * w;
          }
          normalize3(r.tan, i * 3);
          normalize3(r.nor, i * 3);
          if (s.values) {
            const m = s.comps;
            for (let q = 0; q < m; q++) {
              const v = s.values[a * m + q] + (s.values[b * m + q] - s.values[a * m + q]) * w;
              r.val[i * m + q] = t === 'BOOLEAN' ? (v >= 0.5 ? 1 : 0) : t === 'INT' ? Math.round(v) : v;
            }
          }
        }
        return r;
      };
      const out = (key: 'pos' | 'tan' | 'nor' | 'val', ft: FieldType) => new InputField(ft, `sample_curve:${key}:${ctx.path}`, (fc) => full(compute(fc)[key]));
      return {
        Value: out('val', t),
        Position: out('pos', 'VECTOR'),
        Tangent: out('tan', 'VECTOR'),
        Normal: out('nor', 'VECTOR'),
      };
    },
  },
  {
    items: { data_type: ['FLOAT', 'INT', 'BOOLEAN', 'FLOAT_VECTOR', 'FLOAT_COLOR', 'QUATERNION'] },
    dynamicSockets: (node) => {
      const t = fieldTypeOfEnum(prop(node, 'data_type'));
      const byLength = prop(node, 'mode') === 'LENGTH';
      const all = !!prop(node, 'use_all_curves');
      const field = { shape: 'DIAMOND_DOT' as const };
      return {
        inputs: [
          { name: 'Curves', identifier: 'Curves', type: 'GEOMETRY' },
          { ...valueSocket('Value', t), hide_value: true },
          ...(byLength
            ? [{ name: 'Length', identifier: 'Length', type: 'FLOAT' as const, default: 0, subtype: 'DISTANCE', ...field }]
            : [{ name: 'Factor', identifier: 'Factor', type: 'FLOAT' as const, default: 0, min: 0, max: 1, subtype: 'FACTOR', ...field }]),
          ...(all ? [] : [{ name: 'Curve Index', identifier: 'Curve Index', type: 'INT' as const, default: 0, ...field }]),
        ],
        outputs: [
          { ...valueSocket('Value', t), shape: 'DIAMOND_DOT' as const },
          { name: 'Position', identifier: 'Position', type: 'VECTOR', default: [0, 0, 0], ...field },
          { name: 'Tangent', identifier: 'Tangent', type: 'VECTOR', default: [0, 0, 0], ...field },
          { name: 'Normal', identifier: 'Normal', type: 'VECTOR', default: [0, 0, 0], ...field },
        ],
      };
    },
    propPatch: { mode: { expand: true } },
  },
);

place('Curve/Read', 'GeometryNodeInputCurveTilt');
place('Curve/Read', 'GeometryNodeCurveEndpointSelection');
place('Curve/Read', 'GeometryNodeCurveHandleTypeSelection');
place('Curve/Read', 'GeometryNodeSplineLength');
place('Curve/Read', 'GeometryNodeInputSplineResolution');
place('Curve/Sample', 'GeometryNodeSampleCurve');
place('Curve/Topology', 'GeometryNodeCurveOfPoint');
place('Curve/Topology', 'GeometryNodeOffsetPointInCurve');
place('Curve/Topology', 'GeometryNodePointsOfCurve');

gn('GeometryNodeInputTangent', 'input', { exec: () => ({ Tangent: curveTangentField() }) });
place('Curve/Read', 'GeometryNodeInputTangent');
