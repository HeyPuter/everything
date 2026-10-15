// Interpolate Curves: a new curve on every point, blended from the nearest guide curves.
//
// Each point takes its `Max Neighbors` nearest guide roots (first points, same group ID). Guides
// are weighted by inverse distance, faded out towards the next nearest guide so weights fall to
// zero continuously when a guide stops being a neighbour. Guide shapes are resampled to a common
// point count (the weighted average of their counts) and blended relative to their roots.
import { gn } from './defs';
import { evalOn } from '../nodes/common';
import { CurvesComponent, GeometrySet, adaptDomain, gatherArray, type AttrMap, type Component, type PointsComponent } from '../geometry';
import { realizeInstances } from '../ops/join';
import { curveLengths } from '../curveutil';
import { attributeField } from '../inputs';
import { ConstField } from '../field';
import { dataComps } from '../types';
import { evaluateCurves } from './curvedata';
import { place } from './menu';

interface Guide {
  root: [number, number, number];
  /** evaluated points relative to the root */
  pts: Float32Array;
  /** distance along the guide of each point */
  len: Float32Array;
  total: number;
  up: [number, number, number];
  group: number;
}

/** Point on a guide at a fraction of its length (relative to its root). */
function sampleGuide(g: Guide, f: number, out: number[]) {
  const n = g.len.length;
  if (n === 1 || g.total <= 0) {
    out[0] = g.pts[0];
    out[1] = g.pts[1];
    out[2] = g.pts[2];
    return;
  }
  const d = f * g.total;
  let lo = 0,
    hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.len[mid] <= d) lo = mid;
    else hi = mid - 1;
  }
  const b = Math.min(n - 1, lo + 1);
  const seg = g.len[b] - g.len[lo];
  const t = seg > 0 ? Math.min(1, (d - g.len[lo]) / seg) : 0;
  for (let k = 0; k < 3; k++) out[k] = g.pts[lo * 3 + k] + (g.pts[b * 3 + k] - g.pts[lo * 3 + k]) * t;
}

/** Rotation taking unit vector a onto unit vector b (row-major 3×3), identity when undefined. */
function rotationBetween(a: number[], b: number[]): number[] | null {
  const la = Math.hypot(a[0], a[1], a[2]),
    lb = Math.hypot(b[0], b[1], b[2]);
  if (la < 1e-9 || lb < 1e-9) return null;
  const u = a.map((x) => x / la),
    v = b.map((x) => x / lb);
  const c = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const ax = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const s = Math.hypot(ax[0], ax[1], ax[2]);
  if (s < 1e-9) {
    if (c > 0) return null;
    // opposite: half turn around any perpendicular axis
    const p = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const q = [u[1] * p[2] - u[2] * p[1], u[2] * p[0] - u[0] * p[2], u[0] * p[1] - u[1] * p[0]];
    const ql = Math.hypot(q[0], q[1], q[2]);
    const k = q.map((x) => x / ql);
    return [2 * k[0] * k[0] - 1, 2 * k[0] * k[1], 2 * k[0] * k[2], 2 * k[1] * k[0], 2 * k[1] * k[1] - 1, 2 * k[1] * k[2], 2 * k[2] * k[0], 2 * k[2] * k[1], 2 * k[2] * k[2] - 1];
  }
  const k = ax.map((x) => x / s);
  const t = 1 - c;
  return [
    c + k[0] * k[0] * t,
    k[0] * k[1] * t - k[2] * s,
    k[0] * k[2] * t + k[1] * s,
    k[1] * k[0] * t + k[2] * s,
    c + k[1] * k[1] * t,
    k[1] * k[2] * t - k[0] * s,
    k[2] * k[0] * t - k[1] * s,
    k[2] * k[1] * t + k[0] * s,
    c + k[2] * k[2] * t,
  ];
}

export interface InterpolateResult {
  curves: CurvesComponent;
  closestIndex: Int32Array;
  closestWeight: Float32Array;
}

export function interpolateCurves(
  guidesC: CurvesComponent,
  guideUp: Float32Array,
  guideGroup: Int32Array,
  points: Component & { positions: Float32Array },
  pointUp: Float32Array,
  pointGroup: Int32Array,
  maxNeighbors: number,
): InterpolateResult {
  const ev = evaluateCurves(guidesC).curves;
  const L = curveLengths(ev);
  const guides: Guide[] = [];
  for (let k = 0; k < ev.curveCount; k++) {
    const s = ev.curveOffsets[k],
      e = ev.curveOffsets[k + 1];
    if (e <= s) continue;
    const root: [number, number, number] = [ev.positions[s * 3], ev.positions[s * 3 + 1], ev.positions[s * 3 + 2]];
    const pts = new Float32Array((e - s) * 3);
    for (let i = s; i < e; i++) for (let a = 0; a < 3; a++) pts[(i - s) * 3 + a] = ev.positions[i * 3 + a] - root[a];
    guides.push({
      root,
      pts,
      len: L.segment.slice(s, e),
      total: e - s > 1 ? L.segment[e - 1] : 0,
      up: [guideUp[k * 3], guideUp[k * 3 + 1], guideUp[k * 3 + 2]],
      group: guideGroup[k],
    });
  }
  const guideIndex = guides.map((_, i) => i);
  // control point counts (output resolution follows the guides' own points)
  const counts = guides.map((_, i) => guidesC.curveOffsets[i + 1] - guidesC.curveOffsets[i]);
  const P = points.positions;
  const np = P.length / 3;
  const pos: number[] = [];
  const offs: number[] = [0];
  const closestIndex = new Int32Array(np),
    closestWeight = new Float32Array(np);
  const k = Math.max(1, maxNeighbors);
  const tmp = [0, 0, 0];
  for (let p = 0; p < np; p++) {
    const px = P[p * 3],
      py = P[p * 3 + 1],
      pz = P[p * 3 + 2];
    // nearest guides of the same group
    const cand: [number, number][] = [];
    for (const gi of guideIndex) {
      const g = guides[gi];
      if (g.group !== pointGroup[p]) continue;
      cand.push([gi, Math.hypot(g.root[0] - px, g.root[1] - py, g.root[2] - pz)]);
    }
    cand.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const used = cand.slice(0, k);
    const fade = cand.length > k ? cand[k][1] : 0;
    let weights: number[];
    const exact = used.find((c) => c[1] < 1e-9);
    if (exact) weights = used.map((c) => (c === exact ? 1 : 0));
    else weights = used.map(([, d]) => Math.max(0, 1 / d - (fade > 0 ? 1 / fade : 0)));
    const sum = weights.reduce((a, b) => a + b, 0);
    if (!used.length || sum <= 0) {
      // no guide reaches this point: a single point curve
      pos.push(px, py, pz);
      offs.push(pos.length / 3);
      closestIndex[p] = used.length ? used[0][0] : 0;
      closestWeight[p] = 0;
      continue;
    }
    weights = weights.map((w) => w / sum);
    closestIndex[p] = used[0][0];
    closestWeight[p] = weights[0];
    let cnt = 0;
    used.forEach(([gi], i) => (cnt += weights[i] * counts[gi]));
    const n = Math.max(1, Math.round(cnt + 1e-9));
    const rot = used.map(([gi]) => rotationBetween(guides[gi].up, [pointUp[p * 3], pointUp[p * 3 + 1], pointUp[p * 3 + 2]]));
    for (let j = 0; j < n; j++) {
      const f = n > 1 ? j / (n - 1) : 0;
      let x = 0,
        y = 0,
        z = 0;
      used.forEach(([gi], i) => {
        sampleGuide(guides[gi], f, tmp);
        const r = rot[i];
        const v = r ? [r[0] * tmp[0] + r[1] * tmp[1] + r[2] * tmp[2], r[3] * tmp[0] + r[4] * tmp[1] + r[5] * tmp[2], r[6] * tmp[0] + r[7] * tmp[1] + r[8] * tmp[2]] : tmp;
        x += v[0] * weights[i];
        y += v[1] * weights[i];
        z += v[2] * weights[i];
      });
      pos.push(px + x, py + y, pz + z);
    }
    offs.push(pos.length / 3);
  }
  // point attributes of the points become curve attributes
  const attrs: AttrMap = new Map();
  const curves = new CurvesComponent(new Float32Array(pos), Uint32Array.from(offs), new Uint8Array(np), attrs);
  for (const [name, a] of points.attrs) {
    if (name === 'radius' || name.startsWith('#')) continue;
    const data = a.domain === 'POINT' ? a.data : adaptDomain(points, a.data, a.type, a.domain, 'POINT');
    attrs.set(name, {
      domain: 'CURVE',
      type: a.type,
      data: gatherArray(
        data,
        dataComps(a.type),
        Int32Array.from({ length: np }, (_, i) => i),
      ),
    });
  }
  return { curves, closestIndex, closestWeight };
}

gn('GeometryNodeInterpolateCurves', 'geometry', {
  exec: (ctx) => {
    const guides = realizeInstances(ctx.geometry('Guide Curves')).curves;
    const pg = realizeInstances(ctx.geometry('Points'));
    const pts = (pg.points ?? pg.mesh) as (Component & { positions: Float32Array }) | undefined;
    const none = { Curves: GeometrySet.empty(), 'Closest Index': new ConstField('INT', 0), 'Closest Weight': new ConstField('FLOAT', 0) };
    if (!guides || !pts || !pts.positions.length) return none;
    const g = evalOn(guides, 'CURVE', undefined, [ctx.field('Guide Up', 'VECTOR'), ctx.field('Guide Group ID', 'INT')]);
    const p = evalOn(pts, 'POINT', undefined, [ctx.field('Point Up', 'VECTOR'), ctx.field('Point Group ID', 'INT')]);
    const r = interpolateCurves(guides, g.values[0] as Float32Array, g.values[1] as Int32Array, pts, p.values[0] as Float32Array, p.values[1] as Int32Array, ctx.int('Max Neighbors'));
    const out: Record<string, unknown> = {};
    for (const [key, data, t] of [
      ['Closest Index', r.closestIndex, 'INT'],
      ['Closest Weight', r.closestWeight, 'FLOAT'],
    ] as const) {
      if (!ctx.used(key)) {
        out[key] = new ConstField(t, 0);
        continue;
      }
      const name = ctx.anon(key);
      r.curves.attrs.set(name, { domain: 'CURVE', type: t, data });
      out[key] = attributeField(name, t);
    }
    out.Curves = new GeometrySet(undefined, undefined, r.curves);
    return out as Record<string, never>;
  },
});

export type { PointsComponent };

place('Curve/Operations', 'GeometryNodeInterpolateCurves');
