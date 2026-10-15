// Curve and curve primitive nodes.
import { gn, prop, sprop } from './defs';
import { evalOn } from './common';
import { GeometrySet, type CurvesComponent } from '../geometry';
import { curveFromPoints, spiralPoints, quadrilateralPoints, circleFrom3 } from '../ops/primitives';
import { curveToMesh, resampleCurves, fillCurves, curveToPoints } from '../ops/curves';
import { curveLengths } from '../curveutil';
import { attributeField } from '../inputs';
import { ConstField } from '../field';
import { realizeInstances } from '../ops/join';
import { evaluatedCurves, evaluatedWithPointValues } from '../curves/curvedata';

const curveGeo = (c: CurvesComponent) => new GeometrySet(undefined, undefined, c);

gn(
  'GeometryNodeCurvePrimitiveLine',
  'geometry',
  {
    exec: (ctx) => {
      const s = ctx.vector('Start');
      let e = ctx.vector('End');
      if (prop(ctx.node, 'mode') === 'DIRECTION') {
        const d = ctx.vector('Direction'),
          l = ctx.float('Length');
        const dl = Math.hypot(d[0], d[1], d[2]) || 1;
        e = [s[0] + (d[0] / dl) * l, s[1] + (d[1] / dl) * l, s[2] + (d[2] / dl) * l];
      }
      return { Curve: curveGeo(curveFromPoints([s, e], false)) };
    },
  },
  {
    available: (n, s) => {
      const dir = prop(n, 'mode') === 'DIRECTION';
      if (s.identifier === 'End') return !dir;
      if (s.identifier === 'Direction' || s.identifier === 'Length') return dir;
      return true;
    },
    propPatch: { mode: { expand: true } },
  },
);

gn(
  'GeometryNodeCurvePrimitiveCircle',
  'geometry',
  {
    exec: (ctx) => {
      const res = Math.max(3, ctx.int('Resolution'));
      const pts: number[][] = [];
      let center = [0, 0, 0];
      if (prop(ctx.node, 'mode') === 'POINTS') {
        const c = circleFrom3(ctx.vector('Point 1'), ctx.vector('Point 2'), ctx.vector('Point 3'));
        if (!c) {
          ctx.warn('The points are collinear');
          return { Curve: GeometrySet.empty(), Center: [0, 0, 0] };
        }
        center = c.center;
        for (let i = 0; i < res; i++) {
          const th = (2 * Math.PI * i) / res;
          pts.push([0, 1, 2].map((k) => c.center[k] + (c.u[k] * Math.cos(th) + c.v[k] * Math.sin(th)) * c.radius));
        }
      } else {
        const r = ctx.float('Radius');
        for (let i = 0; i < res; i++) {
          const th = (2 * Math.PI * i) / res;
          pts.push([Math.cos(th) * r, Math.sin(th) * r, 0]);
        }
      }
      return { Curve: curveGeo(curveFromPoints(pts, true)), Center: center };
    },
  },
  {
    available: (n, s, out) => {
      const points = prop(n, 'mode') === 'POINTS';
      if (out) return s.identifier === 'Center' ? points : true;
      if (s.identifier.startsWith('Point')) return points;
      if (s.identifier === 'Radius') return !points;
      return true;
    },
    propPatch: { mode: { expand: true } },
  },
);

gn(
  'GeometryNodeCurvePrimitiveQuadrilateral',
  'geometry',
  {
    exec: (ctx) => {
      const vals: Record<string, number | number[]> = {};
      for (const k of ['Width', 'Height', 'Bottom Width', 'Top Width', 'Offset', 'Bottom Height', 'Top Height']) vals[k] = ctx.float(k);
      for (const k of ['Point 1', 'Point 2', 'Point 3', 'Point 4']) vals[k] = ctx.vector(k);
      return {
        Curve: curveGeo(curveFromPoints(quadrilateralPoints(sprop(ctx.node, 'mode'), vals), true)),
      };
    },
  },
  {
    available: (n, s) => {
      const m = sprop(n, 'mode');
      const id = s.identifier;
      const use: Record<string, string[]> = {
        RECTANGLE: ['Width', 'Height'],
        PARALLELOGRAM: ['Width', 'Height', 'Offset'],
        TRAPEZOID: ['Bottom Width', 'Top Width', 'Height', 'Offset'],
        KITE: ['Width', 'Bottom Height', 'Top Height'],
        POINTS: ['Point 1', 'Point 2', 'Point 3', 'Point 4'],
      };
      return (use[m] ?? use.RECTANGLE).includes(id);
    },
  },
);

gn('GeometryNodeCurveSpiral', 'geometry', {
  exec: (ctx) => {
    const res = Math.max(1, ctx.int('Resolution'));
    const rot = ctx.float('Rotations');
    const pts = spiralPoints(res, rot, ctx.float('Start Radius'), ctx.float('End Radius'), ctx.float('Height'), ctx.bool('Reverse'));
    return { Curve: curveGeo(curveFromPoints(pts, false)) };
  },
});

// ---------------------------------------------------------------------------
// Operations

gn('GeometryNodeCurveToMesh', 'geometry', {
  exec: (ctx) => {
    const g = realizeInstances(ctx.geometry('Curve'));
    if (!g.curves) return { Mesh: GeometrySet.empty() };
    const sc = evalOn(g.curves, 'POINT', undefined, [ctx.field('Scale', 'FLOAT')]).values[0] as Float32Array;
    const { curves: c, values: scale } = evaluatedWithPointValues(g.curves, sc);
    const pc = realizeInstances(ctx.geometry('Profile Curve')).curves;
    const profile = pc ? evaluatedCurves(pc) : undefined;
    return {
      Mesh: new GeometrySet(curveToMesh(c, profile, scale, ctx.bool('Fill Caps'))),
    };
  },
});

gn(
  'GeometryNodeResampleCurve',
  'geometry',
  {
    exec: (ctx) => {
      const g = ctx.geometry('Curve');
      if (!g.curves) return { Curve: g };
      const mode = String(prop(ctx.node, 'Mode')) as 'Count' | 'Length' | 'Evaluated';
      const r = evalOn(g.curves, 'CURVE', ctx.field('Selection', 'BOOLEAN'), [ctx.field('Count', 'INT'), ctx.field('Length', 'FLOAT')]);
      const c = evaluatedCurves(g.curves);
      return {
        Curve: g.with(resampleCurves(c, mode, r.values[0] as Int32Array, r.values[1] as Float32Array, r.sel, !!prop(ctx.node, 'keep_last_segment'))),
      };
    },
  },
  {
    menus: {
      Mode: [
        ['Evaluated', 'Evaluated'],
        ['Count', 'Count'],
        ['Length', 'Length'],
      ],
    },
    available: (n, s) => {
      const m = prop(n, 'Mode');
      if (s.identifier === 'Count') return m === 'Count';
      if (s.identifier === 'Length') return m === 'Length';
      return true;
    },
    propPatch: {
      keep_last_segment: { visible: (n) => prop(n, 'Mode') === 'Length' },
    },
  },
);

gn(
  'GeometryNodeFillCurve',
  'geometry',
  {
    exec: (ctx) => {
      const g = realizeInstances(ctx.geometry('Curve'));
      if (!g.curves) return { Mesh: GeometrySet.empty() };
      return {
        Mesh: new GeometrySet(fillCurves(evaluatedCurves(g.curves), prop(ctx.node, 'Mode') === 'N-gons')),
      };
    },
  },
  {
    drop: ['Group ID', 'Fill Rule'],
    menus: {
      Mode: [
        ['Triangles', 'Triangles'],
        ['N-gons', 'N-gons'],
      ],
    },
  },
);

gn(
  'GeometryNodeCurveToPoints',
  'geometry',
  {
    exec: (ctx) => {
      const g = realizeInstances(ctx.geometry('Curve'));
      const c = g.curves ? evaluatedCurves(g.curves) : undefined;
      const none = {
        Points: GeometrySet.empty(),
        Tangent: new ConstField('VECTOR', [0, 0, 0]),
        Normal: new ConstField('VECTOR', [0, 0, 0]),
        Rotation: new ConstField('ROTATION', [0, 0, 0]),
      };
      if (!c) return none;
      const mode = sprop(ctx.node, 'mode') as 'EVALUATED' | 'COUNT' | 'LENGTH';
      const r = evalOn(c, 'CURVE', undefined, [ctx.field('Count', 'INT'), ctx.field('Length', 'FLOAT')]);
      const res = curveToPoints(c, mode, r.values[0] as Int32Array, r.values[1] as Float32Array);
      const out: Record<string, unknown> = {};
      for (const [k, data, t] of [
        ['Tangent', res.tangent, 'VECTOR'],
        ['Normal', res.normal, 'VECTOR'],
        ['Rotation', res.rotation, 'ROTATION'],
      ] as const) {
        if (!ctx.used(k)) {
          out[k] = new ConstField(t, [0, 0, 0]);
          continue;
        }
        const name = ctx.anon(k);
        res.points.attrs.set(name, {
          domain: 'POINT',
          type: t === 'ROTATION' ? 'QUATERNION' : 'FLOAT_VECTOR',
          data,
        });
        out[k] = attributeField(name, t);
      }
      out.Points = new GeometrySet(undefined, res.points);
      return out as Record<string, never>;
    },
  },
  {
    available: (n, s) => {
      const m = sprop(n, 'mode');
      if (s.identifier === 'Count') return m === 'COUNT';
      if (s.identifier === 'Length') return m === 'LENGTH';
      return true;
    },
  },
);

gn('GeometryNodeCurveLength', 'geometry', {
  exec: (ctx) => {
    const c = realizeInstances(ctx.geometry('Curve')).curves;
    if (!c) return { Length: 0 };
    let total = 0;
    for (const l of curveLengths(evaluatedCurves(c)).total) total += l;
    return { Length: total };
  },
});

gn('GeometryNodeSetCurveRadius', 'geometry', {
  exec: (ctx) => {
    const g = ctx.geometry('Curve');
    const c = g.curves;
    if (!c) return { Curve: g };
    const r = evalOn(c, 'POINT', ctx.field('Selection', 'BOOLEAN'), [ctx.field('Radius', 'FLOAT')]);
    const prev = c.attrs.get('radius');
    const data = new Float32Array(c.pointCount);
    if (prev) data.set(prev.data as Float32Array);
    else data.fill(1);
    for (let i = 0; i < c.pointCount; i++) if (!r.sel || r.sel[i]) data[i] = r.values[0][i];
    const out = c.copy();
    out.attrs.set('radius', { domain: 'POINT', type: 'FLOAT', data });
    return { Curve: g.with(out) };
  },
});

gn('GeometryNodeSetSplineCyclic', 'geometry', {
  exec: (ctx) => {
    const g = ctx.geometry('Geometry');
    const c = g.curves;
    if (!c) return { Geometry: g };
    const r = evalOn(c, 'CURVE', ctx.field('Selection', 'BOOLEAN'), [ctx.field('Cyclic', 'BOOLEAN')]);
    const cyc = new Uint8Array(c.cyclic);
    for (let k = 0; k < c.curveCount; k++) if (!r.sel || r.sel[k]) cyc[k] = r.values[0][k] ? 1 : 0;
    const out = c.copy();
    out.cyclic = cyc;
    return { Geometry: g.with(out) };
  },
});
