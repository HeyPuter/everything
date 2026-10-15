// Curve writing nodes: Set Handle Type, Set Spline Type, Set Handle Positions, Set Curve Tilt,
// Set Curve Normal, Set Spline Resolution, Set NURBS Order, Set NURBS Weight.
import { h } from '../../ui/h';
import { gn, prop } from './defs';
import { evalOn } from '../nodes/common';
import { CurvesComponent, type Component } from '../geometry';
import type { NodeData, SocketValue } from '../../data/types';
import type { NodeDrawContext } from '../../nodes/types';
import type { ExecContext } from '../exec';
import {
  CT,
  CURVE_TYPE_IDS,
  DEFAULT_ORDER,
  HANDLE_TYPE_IDS,
  HT,
  KNOTS,
  curveInts,
  curveTypes,
  handleData,
  pointFloats,
  pointVectors,
  recalcHandles,
  setCurveAttr,
  setPointAttr,
  writeHandles,
} from './curvedata';
import { place } from './menu';
import { assembleCurves, lerp3, P3, type OutCurve } from './assemble';

// ---------------------------------------------------------------------------
// Left/right flag property (stored as "LEFT,RIGHT")

export function flagSet(node: NodeData, id: string, d = 'LEFT,RIGHT'): Set<string> {
  const v = node.props[id] as SocketValue | string[] | undefined;
  if (Array.isArray(v)) return new Set(v.map(String));
  return new Set(
    String(v ?? d)
      .split(',')
      .filter(Boolean),
  );
}

/** Toggle row for a left/right flag property (at least one side stays enabled). */
export function sideToggles(id: string) {
  return (ctx: NodeDrawContext) => {
    const cur = flagSet(ctx.node, id);
    return h(
      'div',
      { class: 'enum-row nd-enum-row' },
      ['LEFT', 'RIGHT'].map((side) =>
        h(
          'button',
          {
            key: side,
            class: { on: cur.has(side) },
            title: side === 'LEFT' ? 'Left handles' : 'Right handles',
            onclick: () => {
              const next = new Set(cur);
              if (next.has(side)) next.delete(side);
              else next.add(side);
              if (!next.size) return;
              ctx.node.props[id] = ['LEFT', 'RIGHT'].filter((s) => next.has(s)).join(',');
              ctx.changed('Change Mode', true);
            },
          },
          side === 'LEFT' ? 'Left' : 'Right',
        ),
      ),
    );
  };
}

const curvesOf = (ctx: ExecContext, id: string) => ctx.geometry(id);

/** Apply `fn` to the curves component of a geometry input and return the geometry. */
function onCurves(ctx: ExecContext, input: string, fn: (c: CurvesComponent) => CurvesComponent): Record<string, unknown> {
  const g = curvesOf(ctx, input);
  if (!g.curves) return { [input]: g };
  return { [input]: g.with(fn(g.curves)) };
}

// ---------------------------------------------------------------------------
// Set Handle Type

export function setHandleTypes(c: CurvesComponent, sel: Uint8Array | null, type: number, left: boolean, right: boolean): CurvesComponent {
  const types = curveTypes(c);
  if (!types || !types.some((t) => t === CT.BEZIER)) return c;
  const hd = handleData(c);
  const pc = c.pointCurve();
  for (let i = 0; i < c.pointCount; i++) {
    if (types[pc[i]] !== CT.BEZIER || (sel && !sel[i])) continue;
    if (left) hd.tl[i] = type;
    if (right) hd.tr[i] = type;
  }
  recalcHandles(c.positions, c.curveOffsets, c.cyclic, types, hd.left, hd.right, hd.tl, hd.tr);
  const out = c.copy();
  writeHandles(out, hd);
  return out;
}

gn(
  'GeometryNodeCurveSetHandles',
  'geometry',
  {
    exec: (ctx) =>
      onCurves(ctx, 'Curve', (c) => {
        const sel = evalOn(c, 'POINT', ctx.field('Selection', 'BOOLEAN'), []).sel;
        const f = flagSet(ctx.node, 'mode');
        return setHandleTypes(c, sel, HANDLE_TYPE_IDS.indexOf(String(prop(ctx.node, 'handle_type')) as never), f.has('LEFT'), f.has('RIGHT'));
      }) as Record<string, never>,
  },
  {
    propPatch: {
      mode: { visible: () => false },
      handle_type: { expand: true },
    },
    drawBody: sideToggles('mode'),
    bodyHeight: () => 26,
  },
);

// ---------------------------------------------------------------------------
// Set Spline Type

/** Catmull-Rom tangent handles (aligned) of the points of one curve. */
function catmullHandles(P: Float32Array, s: number, e: number, cyc: boolean): { left: number[]; right: number[] } {
  const n = e - s;
  const left: number[] = [],
    right: number[] = [];
  for (let i = s; i < e; i++) {
    const pi = i > s ? i - 1 : cyc ? e - 1 : i,
      ni = i < e - 1 ? i + 1 : cyc ? s : i;
    const d = [0, 1, 2].map((k) => (n > 1 ? (P[ni * 3 + k] - P[pi * 3 + k]) / 6 : 0));
    for (let k = 0; k < 3; k++) {
      left.push(P[i * 3 + k] - d[k]);
      right.push(P[i * 3 + k] + d[k]);
    }
  }
  return { left, right };
}

/** NURBS control points as Bézier points (cubic B-spline segments, or handle triples for Bézier knots). */
function nurbsToBezier(c: CurvesComponent, k: number, knots: number, order: number): OutCurve {
  const s = c.curveOffsets[k],
    e = c.curveOffsets[k + 1],
    n = e - s;
  const P = c.positions;
  const cyc = !!c.cyclic[k];
  const at = (i: number) => P3(P, s + (((i % n) + n) % n));
  const out: OutCurve = {
    src: [],
    pos: [],
    left: [],
    right: [],
    tl: [],
    tr: [],
    type: CT.BEZIER,
  };
  const add = (srcIdx: number, p: number[], l: number[], r: number[]) => {
    out.src.push(srcIdx);
    out.pos.push(...p);
    out.left!.push(...l);
    out.right!.push(...r);
    out.tl!.push(HT.ALIGN);
    out.tr!.push(HT.ALIGN);
  };
  if ((knots === KNOTS.BEZIER || knots === KNOTS.ENDPOINT_BEZIER) && order === 4 && n >= 3) {
    // handle triples: left, point, right
    const groups = Math.floor(n / 3);
    for (let g = 0; g < groups; g++) add(s + g * 3 + 1, at(g * 3 + 1), at(g * 3), at(g * 3 + 2));
    return out;
  }
  if (cyc) {
    for (let j = 0; j < n; j++) {
      const i = j + 1;
      const a = at(i - 1),
        b = at(i),
        d = at(i + 1);
      const p = [0, 1, 2].map((q) => (a[q] + 4 * b[q] + d[q]) / 6);
      add(s + (i % n), p, lerp3(b, a, 1 / 3), lerp3(b, d, 1 / 3));
    }
    return out;
  }
  if (n < 4) {
    // too few points for a cubic segment: span the end points
    const p0 = at(0),
      p1 = at(n - 1);
    const h0 = n === 3 ? at(1) : lerp3(p0, p1, 1 / 3),
      h1 = n === 3 ? at(1) : lerp3(p0, p1, 2 / 3);
    add(s, p0, lerp3(p0, h0, -1), h0);
    add(e - 1, p1, h1, lerp3(p1, h1, -1));
    return out;
  }
  // clamped cubic B-spline: legs between interior control points split into thirds (halves at the ends)
  const legs = n - 3; // legs P1P2 .. P(n-3)P(n-2)
  const a: number[][] = [],
    b: number[][] = [];
  for (let i = 1; i <= legs; i++) {
    const p = at(i),
      q = at(i + 1);
    a[i] = i === 1 ? p : lerp3(p, q, i === legs ? 0.5 : 1 / 3);
    b[i] = i === legs ? q : lerp3(p, q, i === 1 ? 0.5 : 2 / 3);
  }
  const p0 = at(0);
  add(s, p0, lerp3(p0, at(1), -1), at(1));
  for (let j = 1; j < legs; j++) {
    const l = b[j],
      r = a[j + 1];
    add(s + j + 1, lerp3(l, r, 0.5), l, r);
  }
  const pl = at(n - 1);
  add(e - 1, pl, at(n - 2), lerp3(pl, at(n - 2), -1));
  return out;
}

export function setSplineType(c0: CurvesComponent, sel: Uint8Array | null, dst: number): CurvesComponent {
  const types = curveTypes(c0) ?? new Int32Array(c0.curveCount).fill(CT.POLY);
  let any = false;
  for (let k = 0; k < c0.curveCount; k++) if ((!sel || sel[k]) && types[k] !== dst) any = true;
  if (!any) return c0;
  const c = c0;
  const P = c.positions;
  const left = pointVectors(c, 'handle_left', P),
    right = pointVectors(c, 'handle_right', P);
  const knotsMode = curveInts(c, 'knots_mode', KNOTS.NORMAL),
    orders = curveInts(c, 'nurbs_order', DEFAULT_ORDER);
  const outs: OutCurve[] = [];
  for (let k = 0; k < c.curveCount; k++) {
    const s = c.curveOffsets[k],
      e = c.curveOffsets[k + 1];
    const cyc = !!c.cyclic[k];
    const from = types[k];
    const keep = (): OutCurve => {
      const o: OutCurve = { src: [], pos: [], type: from };
      for (let i = s; i < e; i++) {
        o.src.push(i);
        o.pos.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
      }
      return o;
    };
    if ((sel && !sel[k]) || from === dst) {
      outs.push(keep());
      continue;
    }
    if (dst === CT.POLY || dst === CT.CATMULL_ROM) {
      const o = keep();
      o.type = dst;
      outs.push(o);
      continue;
    }
    if (dst === CT.BEZIER) {
      if (from === CT.NURBS) {
        outs.push(nurbsToBezier(c, k, knotsMode[k], orders[k]));
        continue;
      }
      const o = keep();
      o.type = CT.BEZIER;
      if (from === CT.CATMULL_ROM) {
        const hd = catmullHandles(P, s, e, cyc);
        o.left = hd.left;
        o.right = hd.right;
        o.tl = o.src.map(() => HT.ALIGN);
        o.tr = o.src.map(() => HT.ALIGN);
      } else {
        // poly: vector handles (computed below)
        o.left = o.pos.slice();
        o.right = o.pos.slice();
        o.tl = o.src.map(() => HT.VECTOR);
        o.tr = o.src.map(() => HT.VECTOR);
      }
      outs.push(o);
      continue;
    }
    // to NURBS
    if (from === CT.POLY) {
      const o = keep();
      o.type = CT.NURBS;
      o.knots = cyc ? KNOTS.NORMAL : KNOTS.ENDPOINT;
      o.order = DEFAULT_ORDER;
      outs.push(o);
      continue;
    }
    // Bézier / Catmull-Rom: every point becomes left handle, point, right handle
    const hd = from === CT.CATMULL_ROM ? catmullHandles(P, s, e, cyc) : null;
    const o: OutCurve = {
      src: [],
      pos: [],
      type: CT.NURBS,
      knots: KNOTS.BEZIER,
      order: DEFAULT_ORDER,
    };
    for (let i = s; i < e; i++) {
      const j = i - s;
      const l = hd ? hd.left.slice(j * 3, j * 3 + 3) : P3(left, i),
        r = hd ? hd.right.slice(j * 3, j * 3 + 3) : P3(right, i);
      o.src.push(i, i, i);
      o.pos.push(...l, P[i * 3], P[i * 3 + 1], P[i * 3 + 2], ...r);
    }
    outs.push(o);
  }
  const out = assembleCurves(c, outs);
  if (out.attrs.has('nurbs_weight') && !outs.some((o) => o.type === CT.NURBS)) out.attrs.delete('nurbs_weight');
  const t = curveTypes(out);
  if (t && t.some((x) => x === CT.BEZIER)) {
    const hd = handleData(out);
    recalcHandles(out.positions, out.curveOffsets, out.cyclic, t, hd.left, hd.right, hd.tl, hd.tr);
    writeHandles(out, hd);
  }
  return out;
}

gn(
  'GeometryNodeCurveSplineType',
  'geometry',
  {
    exec: (ctx) =>
      onCurves(ctx, 'Curve', (c) => {
        const sel = evalOn(c, 'CURVE', ctx.field('Selection', 'BOOLEAN'), []).sel;
        return setSplineType(c, sel, CURVE_TYPE_IDS.indexOf(String(prop(ctx.node, 'spline_type')) as never));
      }) as Record<string, never>,
  },
  { propPatch: { spline_type: { noLabel: true } } },
);

// ---------------------------------------------------------------------------
// Set Handle Positions

export function setHandlePositions(c: CurvesComponent, sel: Uint8Array | null, posv: Float32Array | null, off: Float32Array, side: 'LEFT' | 'RIGHT'): CurvesComponent {
  const types = curveTypes(c);
  if (!types || !types.some((t) => t === CT.BEZIER)) return c;
  const hd = handleData(c);
  const pc = c.pointCurve();
  const isL = side === 'LEFT';
  const H = isL ? hd.left : hd.right,
    O = isL ? hd.right : hd.left;
  const T = isL ? hd.tl : hd.tr,
    TO = isL ? hd.tr : hd.tl;
  const P = c.positions;
  for (let i = 0; i < c.pointCount; i++) {
    if (types[pc[i]] !== CT.BEZIER || (sel && !sel[i])) continue;
    for (let k = 0; k < 3; k++) H[i * 3 + k] = (posv ? posv[i * 3 + k] : H[i * 3 + k]) + off[i * 3 + k];
    if (T[i] === HT.AUTO && TO[i] === HT.AUTO) {
      T[i] = HT.ALIGN;
      TO[i] = HT.ALIGN;
    } else if (!(T[i] === HT.ALIGN && TO[i] === HT.ALIGN)) T[i] = HT.FREE;
    if (TO[i] === HT.ALIGN) {
      // keep the other handle aligned with the edited one
      const d = [P[i * 3] - H[i * 3], P[i * 3 + 1] - H[i * 3 + 1], P[i * 3 + 2] - H[i * 3 + 2]];
      const l = Math.hypot(d[0], d[1], d[2]);
      const own = Math.hypot(O[i * 3] - P[i * 3], O[i * 3 + 1] - P[i * 3 + 1], O[i * 3 + 2] - P[i * 3 + 2]);
      if (l > 1e-12) for (let k = 0; k < 3; k++) O[i * 3 + k] = P[i * 3 + k] + (d[k] / l) * own;
    }
  }
  // auto and vector handles of other points do not depend on handles; aligned ones were handled
  const out = c.copy();
  writeHandles(out, hd);
  return out;
}

gn(
  'GeometryNodeSetCurveHandlePositions',
  'geometry',
  {
    exec: (ctx) =>
      onCurves(ctx, 'Curve', (c) => {
        const side = String(prop(ctx.node, 'mode')) === 'RIGHT' ? 'RIGHT' : 'LEFT';
        const fields = [ctx.field('Offset', 'VECTOR')];
        const linked = ctx.linked('Position');
        if (linked) fields.push(ctx.field('Position', 'VECTOR'));
        const r = evalOn(c, 'POINT', ctx.field('Selection', 'BOOLEAN'), fields);
        return setHandlePositions(c, r.sel, linked ? (r.values[1] as Float32Array) : null, r.values[0] as Float32Array, side);
      }) as Record<string, never>,
  },
  { propPatch: { mode: { expand: true } } },
);

// ---------------------------------------------------------------------------
// Simple attribute writers

function writePointFloat(c: CurvesComponent, name: string, sel: Uint8Array | null, vals: ArrayLike<number>, def: number): CurvesComponent {
  const data = new Float32Array(pointFloats(c, name, def));
  for (let i = 0; i < c.pointCount; i++) if (!sel || sel[i]) data[i] = vals[i];
  const out = c.copy();
  setPointAttr(out.attrs, name, 'FLOAT', data);
  return out;
}

function writeCurveInt(c: CurvesComponent, name: string, sel: Uint8Array | null, vals: ArrayLike<number>, def: number, type: 'INT' | 'INT8', clamp: (x: number) => number): CurvesComponent {
  const data = new Int32Array(curveInts(c, name, def));
  for (let k = 0; k < c.curveCount; k++) if (!sel || sel[k]) data[k] = clamp(vals[k]);
  const out = c.copy();
  setCurveAttr(out.attrs, name, type, data);
  return out;
}

gn('GeometryNodeSetCurveTilt', 'geometry', {
  exec: (ctx) =>
    onCurves(ctx, 'Curve', (c) => {
      const r = evalOn(c, 'POINT', ctx.field('Selection', 'BOOLEAN'), [ctx.field('Tilt', 'FLOAT')]);
      return writePointFloat(c, 'tilt', r.sel, r.values[0], 0);
    }) as Record<string, never>,
});

const NORMAL_MODES: [string, string][] = [
  ['Minimum Twist', 'Minimum Twist'],
  ['Z Up', 'Z Up'],
  ['Free', 'Free'],
];

gn(
  'GeometryNodeSetCurveNormal',
  'geometry',
  {
    exec: (ctx) =>
      onCurves(ctx, 'Curve', (c) => {
        const mode = Math.max(
          0,
          NORMAL_MODES.findIndex(([v]) => v === prop(ctx.node, 'Mode')),
        );
        const fields = mode === 2 ? [ctx.field('Normal', 'VECTOR')] : [];
        const r = evalOn(c, 'CURVE', ctx.field('Selection', 'BOOLEAN'), []);
        let out = writeCurveInt(c, 'normal_mode', r.sel, new Int32Array(c.curveCount).fill(mode), 0, 'INT8', (x) => x);
        if (mode === 2) {
          const pr = evalOn(c, 'POINT', undefined, fields);
          const pc = c.pointCurve();
          const data = new Float32Array(pointVectors(c, 'custom_normal', new Float32Array(c.pointCount * 3)));
          const v = pr.values[0] as Float32Array;
          for (let i = 0; i < c.pointCount; i++) if (!r.sel || r.sel[pc[i]]) data.set(v.subarray(i * 3, i * 3 + 3), i * 3);
          out = out === c ? c.copy() : out;
          setPointAttr(out.attrs, 'custom_normal', 'FLOAT_VECTOR', data);
        }
        return out;
      }) as Record<string, never>,
  },
  {
    menus: { Mode: NORMAL_MODES },
    available: (n, s) => (s.identifier === 'Normal' ? prop(n, 'Mode') === 'Free' : true),
  },
);

gn('GeometryNodeSetSplineResolution', 'geometry', {
  exec: (ctx) => {
    const g = ctx.geometry('Geometry');
    if (!g.curves) return { Geometry: g };
    const c = g.curves;
    const r = evalOn(c, 'CURVE', ctx.field('Selection', 'BOOLEAN'), [ctx.field('Resolution', 'INT')]);
    return {
      Geometry: g.with(writeCurveInt(c, 'resolution', r.sel, r.values[0], 12, 'INT', (x) => Math.max(1, x))),
    };
  },
});

gn('GeometryNodeSetNURBSOrder', 'geometry', {
  exec: (ctx) =>
    onCurves(ctx, 'Curves', (c) => {
      const r = evalOn(c, 'CURVE', ctx.field('Selection', 'BOOLEAN'), [ctx.field('Order', 'INT')]);
      return writeCurveInt(c, 'nurbs_order', r.sel, r.values[0], DEFAULT_ORDER, 'INT8', (x) => Math.max(2, Math.min(127, x)));
    }) as Record<string, never>,
});

gn('GeometryNodeSetNURBSWeight', 'geometry', {
  exec: (ctx) =>
    onCurves(ctx, 'Curves', (c) => {
      const r = evalOn(c, 'POINT', ctx.field('Selection', 'BOOLEAN'), [ctx.field('Weight', 'FLOAT')]);
      return writePointFloat(c, 'nurbs_weight', r.sel, r.values[0], 1);
    }) as Record<string, never>,
});

export type { Component };

place('Curve/Write', 'GeometryNodeSetCurveNormal');
place('Curve/Write', 'GeometryNodeSetCurveTilt');
place('Curve/Write', 'GeometryNodeSetCurveHandlePositions');
place('Curve/Write', 'GeometryNodeCurveSetHandles');
place('Curve/Write', 'GeometryNodeSetNURBSOrder');
place('Curve/Write', 'GeometryNodeSetNURBSWeight');
place('Curve/Write', 'GeometryNodeSetSplineResolution');
place('Curve/Write', 'GeometryNodeCurveSplineType');
