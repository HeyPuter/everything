// Curve primitive nodes: Arc, Star, Bézier Segment, Quadratic Bézier.
import { gn, prop, sprop } from './defs';
import { GeometrySet, type CurvesComponent } from '../geometry';
import { circleFrom3 } from '../ops/primitives';
import { attributeField } from '../inputs';
import { ConstField } from '../field';
import { buildCurves, CT, HT } from './curvedata';
import { place } from './menu';

const curveGeo = (c: CurvesComponent) => new GeometrySet(undefined, undefined, c);
type V3 = [number, number, number];
const sub = (a: number[], b: number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: number[], b: number[]): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: number[], s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: number[]): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const TAU = Math.PI * 2;

/** Points of an arc in the XY plane (radius mode). */
export function arcRadiusPoints(res: number, radius: number, start: number, sweep: number, invert: boolean): V3[] {
  const count = Math.max(2, res);
  let sw = sweep;
  if (invert) sw = sweep - Math.sign(sweep || 1) * TAU;
  const out: V3[] = [];
  for (let i = 0; i < count; i++) {
    const a = start + (sw * i) / (count - 1);
    out.push([Math.cos(a) * radius, Math.sin(a) * radius, 0]);
  }
  return out;
}

/** Arc through three points; null when they do not define a circle. */
export function arcThreePoints(res: number, start: number[], middle: number[], end: number[], offset: number, invert: boolean): { points: V3[]; center: V3; normal: V3; radius: number } | null {
  const count = Math.max(2, res);
  const circ = circleFrom3(start, middle, end);
  const n = norm(cross(sub(end, start), sub(middle, start)));
  if (!circ || !Number.isFinite(circ.radius)) return null;
  const c = circ.center as V3;
  const r = circ.radius;
  const u = norm(sub(start, c));
  const v = cross(n, u);
  const ang = (p: number[]) => {
    const d = sub(p, c);
    let a = Math.atan2(dot(d, v), dot(d, u));
    if (a < 0) a += TAU;
    return a;
  };
  const am = ang(middle),
    ae = ang(end);
  // go the way that passes the middle point
  let sweep = am < ae ? ae : ae - TAU;
  if (invert) sweep = sweep > 0 ? sweep - TAU : sweep + TAU;
  const points: V3[] = [];
  for (let i = 0; i < count; i++) {
    const a = (sweep * i) / (count - 1) - offset;
    points.push(add(c, add(scale(u, Math.cos(a) * r), scale(v, Math.sin(a) * r))));
  }
  return { points, center: c, normal: n, radius: r };
}

gn(
  'GeometryNodeCurveArc',
  'geometry',
  {
    exec: (ctx) => {
      const res = ctx.int('Resolution');
      const connect = ctx.bool('Connect Center'),
        invert = ctx.bool('Invert Arc');
      if (sprop(ctx.node, 'mode') === 'POINTS') {
        const s = ctx.vector('Start'),
          m = ctx.vector('Middle'),
          e = ctx.vector('End');
        const r = arcThreePoints(res, s, m, e, ctx.float('Offset Angle'), invert);
        if (!r) {
          const pts = Array.from({ length: Math.max(2, res) }, () => [...s]);
          return {
            Curve: curveGeo(buildCurves([{ points: pts, cyclic: connect }])),
            Center: s,
            Normal: [0, 0, 1],
            Radius: 0,
          };
        }
        const pts: number[][] = r.points;
        if (connect) pts.push(r.center);
        return {
          Curve: curveGeo(buildCurves([{ points: pts, cyclic: connect }])),
          Center: r.center,
          Normal: r.normal,
          Radius: r.radius,
        };
      }
      const pts: number[][] = arcRadiusPoints(res, ctx.float('Radius'), ctx.float('Start Angle'), ctx.float('Sweep Angle'), invert);
      if (connect) pts.push([0, 0, 0]);
      return {
        Curve: curveGeo(buildCurves([{ points: pts, cyclic: connect }])),
        Center: [0, 0, 0],
        Normal: [0, 0, 1],
        Radius: 0,
      };
    },
  },
  {
    available: (n, s, out) => {
      const points = prop(n, 'mode') === 'POINTS';
      const id = s.identifier;
      if (out) return id === 'Curve' ? true : points;
      if (id === 'Start' || id === 'Middle' || id === 'End' || id === 'Offset Angle') return points;
      if (id === 'Radius' || id === 'Start Angle' || id === 'Sweep Angle') return !points;
      return true;
    },
    propPatch: { mode: { expand: true } },
  },
);

gn('GeometryNodeCurveStar', 'geometry', {
  exec: (ctx) => {
    const count = Math.max(3, ctx.int('Points'));
    const ri = ctx.float('Inner Radius'),
      ro = ctx.float('Outer Radius'),
      twist = ctx.float('Twist');
    const pts: number[][] = [];
    for (let i = 0; i < count; i++) {
      const a = (TAU * i) / count;
      pts.push([Math.cos(a) * ro, Math.sin(a) * ro, 0]);
      const b = a + Math.PI / count + twist;
      pts.push([Math.cos(b) * ri, Math.sin(b) * ri, 0]);
    }
    const c = buildCurves([{ points: pts, cyclic: true }]);
    const out: Record<string, unknown> = {};
    if (ctx.used('Outer Points')) {
      const name = ctx.anon('Outer Points');
      const sel = new Uint8Array(pts.length);
      for (let i = 0; i < pts.length; i += 2) sel[i] = 1;
      c.attrs.set(name, { domain: 'POINT', type: 'BOOLEAN', data: sel });
      out['Outer Points'] = attributeField(name, 'BOOLEAN');
    } else out['Outer Points'] = new ConstField('BOOLEAN', false);
    out.Curve = curveGeo(c);
    return out as Record<string, never>;
  },
});

gn(
  'GeometryNodeCurvePrimitiveBezierSegment',
  'geometry',
  {
    exec: (ctx) => {
      const res = Math.max(1, ctx.int('Resolution'));
      const s = ctx.vector('Start'),
        e = ctx.vector('End');
      let hs: number[] = ctx.vector('Start Handle'),
        he: number[] = ctx.vector('End Handle');
      if (sprop(ctx.node, 'mode') === 'OFFSET') {
        hs = add(s, hs);
        he = add(e, he);
      }
      // the outer handles mirror the inner ones (aligned handles)
      const c = buildCurves([
        {
          points: [s, e],
          type: CT.BEZIER,
          resolution: res,
          right: [hs, sub(scale(e, 2), he)],
          left: [sub(scale(s, 2), hs), he],
          typeLeft: HT.ALIGN,
          typeRight: HT.ALIGN,
        },
      ]);
      return { Curve: curveGeo(c) };
    },
  },
  { propPatch: { mode: { expand: true } } },
);

gn('GeometryNodeCurveQuadraticBezier', 'geometry', {
  exec: (ctx) => {
    const res = Math.max(1, ctx.int('Resolution'));
    const s = ctx.vector('Start'),
      m = ctx.vector('Middle'),
      e = ctx.vector('End');
    const pts: number[][] = [];
    for (let i = 0; i <= res; i++) {
      const t = i / res,
        u = 1 - t;
      pts.push([0, 1, 2].map((k) => u * u * s[k] + 2 * u * t * m[k] + t * t * e[k]));
    }
    return { Curve: curveGeo(buildCurves([{ points: pts }])) };
  },
});

place('Curve/Primitives', 'GeometryNodeCurveArc');
place('Curve/Primitives', 'GeometryNodeCurvePrimitiveBezierSegment');
place('Curve/Primitives', 'GeometryNodeCurveQuadraticBezier');
place('Curve/Primitives', 'GeometryNodeCurveStar');
