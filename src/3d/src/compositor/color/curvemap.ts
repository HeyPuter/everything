// Curve mapping evaluation for the curve widgets: cubic Bézier segments with
// automatically computed handles (end handles aim at the neighbour's handle), "vector" handles
// (straight segments) and auto-clamped handles (flat at extrema); outside the points the curve
// extends horizontally or along the end tangents. The curves themselves are stored by the
// shared curve widget (nodes/curves.ts: props.curve_<i> = [x, y, handle, …]).
import type { SocketValue } from '../../data/types';
import { readCurve, type CurvePoint } from '../../nodes/curves';

type V2 = [number, number];

/** Bézier handles (left, right) of each point. */
export function curveHandles(pts: CurvePoint[]): [V2, V2][] {
  const n = pts.length;
  const H: [V2, V2][] = [];
  for (let i = 0; i < n; i++) {
    const p: V2 = [pts[i].x, pts[i].y];
    const prev: V2 = i > 0 ? [pts[i - 1].x, pts[i - 1].y] : n > 1 ? [2 * p[0] - pts[i + 1].x, 2 * p[1] - pts[i + 1].y] : [p[0] - 1, p[1]];
    const next: V2 = i < n - 1 ? [pts[i + 1].x, pts[i + 1].y] : n > 1 ? [2 * p[0] - pts[i - 1].x, 2 * p[1] - pts[i - 1].y] : [p[0] + 1, p[1]];
    if (pts[i].handle === 1) {
      // vector: a third of the way towards the neighbours
      H.push([
        [p[0] + (prev[0] - p[0]) / 3, p[1] + (prev[1] - p[1]) / 3],
        [p[0] + (next[0] - p[0]) / 3, p[1] + (next[1] - p[1]) / 3],
      ]);
      continue;
    }
    const da: V2 = [p[0] - prev[0], p[1] - prev[1]],
      db: V2 = [next[0] - p[0], next[1] - p[1]];
    let la = Math.hypot(da[0], da[1]) || 1e-9,
      lb = Math.hypot(db[0], db[1]) || 1e-9;
    const t: V2 = [da[0] / la + db[0] / lb, da[1] / la + db[1] / lb];
    const len = Math.hypot(t[0], t[1]) * 2.5614;
    if (len === 0) {
      H.push([[...p], [...p]]);
      continue;
    }
    la /= len;
    lb /= len;
    const left: V2 = [p[0] - t[0] * la, p[1] - t[1] * la],
      right: V2 = [p[0] + t[0] * lb, p[1] + t[1] * lb];
    if (pts[i].handle === 2 && i > 0 && i < n - 1) {
      const ext = (prev[1] - p[1]) * (next[1] - p[1]) >= 0;
      if (ext) {
        left[1] = p[1];
        right[1] = p[1];
      }
    }
    H.push([left, right]);
  }
  // end points: aim the handle at the neighbour's handle, keeping its length
  if (n > 2) {
    for (const [i, j] of [
      [0, 1],
      [n - 1, n - 2],
    ] as const) {
      if (pts[i].handle === 1) continue;
      const p: V2 = [pts[i].x, pts[i].y];
      const h = i === 0 ? H[i][1] : H[i][0];
      const hl = Math.hypot(h[0] - p[0], h[1] - p[1]);
      const tgt = i === 0 ? H[j][0] : H[j][1];
      const d: V2 = [tgt[0] - p[0], tgt[1] - p[1]];
      const dl = Math.hypot(d[0], d[1]) || 1;
      const nh: V2 = [p[0] + (d[0] / dl) * hl, p[1] + (d[1] / dl) * hl];
      if (i === 0) H[i] = [H[i][0], nh];
      else H[i] = [nh, H[i][1]];
    }
  }
  return H;
}

function bez(a: number, b: number, c: number, d: number, t: number) {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}

export interface CurveEval {
  (x: number): number;
  x0: number;
  x1: number;
  /** end slopes (0 when extending horizontally) */
  s0: number;
  s1: number;
  y0: number;
  y1: number;
}

/** Evaluator for one curve (points sorted by x). */
export function curveEvaluator(pts: CurvePoint[], extend: string = 'EXTRAPOLATED'): CurveEval {
  const P = [...pts].sort((a, b) => a.x - b.x);
  if (!P.length) P.push({ x: 0, y: 0, handle: 0 }, { x: 1, y: 1, handle: 0 });
  const H = curveHandles(P);
  const n = P.length;
  const extrap = extend === 'EXTRAPOLATED';
  let s0 = 0,
    s1 = 0;
  if (extrap && n > 1) {
    const h0 = H[0][1],
      h1 = H[n - 1][0];
    s0 = Math.abs(h0[0] - P[0].x) > 1e-9 ? (h0[1] - P[0].y) / (h0[0] - P[0].x) : 0;
    s1 = Math.abs(P[n - 1].x - h1[0]) > 1e-9 ? (P[n - 1].y - h1[1]) / (P[n - 1].x - h1[0]) : 0;
  }
  const f = ((x: number) => {
    if (n === 1) return P[0].y;
    if (x <= P[0].x) return P[0].y + (x - P[0].x) * s0;
    if (x >= P[n - 1].x) return P[n - 1].y + (x - P[n - 1].x) * s1;
    let i = 0;
    while (i < n - 2 && x > P[i + 1].x) i++;
    const a = P[i],
      b = P[i + 1];
    const ha = H[i][1],
      hb = H[i + 1][0];
    // the x handles are kept inside the segment so x(t) is monotonic
    const ax = Math.min(Math.max(ha[0], a.x), b.x),
      bx = Math.min(Math.max(hb[0], a.x), b.x);
    let lo = 0,
      hi = 1;
    for (let k = 0; k < 40; k++) {
      const m = (lo + hi) / 2;
      if (bez(a.x, ax, bx, b.x, m) < x) lo = m;
      else hi = m;
    }
    return bez(a.y, ha[1], hb[1], b.y, (lo + hi) / 2);
  }) as CurveEval;
  f.x0 = P[0].x;
  f.x1 = P[n - 1].x;
  f.s0 = s0;
  f.s1 = s1;
  f.y0 = P[0].y;
  f.y1 = P[n - 1].y;
  return f;
}

/** Evaluators of every curve of a node (props written by the curve widget). */
export function nodeCurves(props: Record<string, SocketValue>, count: number): CurveEval[] {
  const extend = (props.curve_extend as string) ?? 'EXTRAPOLATED';
  const out: CurveEval[] = [];
  for (let i = 0; i < count; i++) out.push(curveEvaluator(readCurve(props, i), extend));
  return out;
}

export const CURVE_LUT = 1024;

/**
 * Bake curves into rows of an RGBA float table for the GPU: row r holds curve r sampled over
 * [x0, x1] in the red channel. Returns the data and per-curve parameters (x0, x1, s0, s1).
 */
export function bakeCurveTable(curves: CurveEval[], n = CURVE_LUT): { data: Float32Array; params: Float32Array } {
  const data = new Float32Array(n * curves.length * 4);
  const params = new Float32Array(curves.length * 4);
  curves.forEach((c, r) => {
    const span = c.x1 - c.x0;
    for (let i = 0; i < n; i++) {
      const x = c.x0 + (span * i) / (n - 1);
      const y = c(x);
      data.set([y, y, y, 1], (r * n + i) * 4);
    }
    params.set([c.x0, c.x1, c.s0, c.s1], r * 4);
  });
  return { data, params };
}

export const CURVE_GLSL = /* glsl */ `
// table row r: n samples over [p.x, p.y]; outside: end value + slope (p.z / p.w)
float cmp_curve(sampler2D lut, vec4 p, int row, float x) {
  int n = textureSize(lut, 0).x;
  float span = p.y - p.x;
  if (span <= 0.0) return texelFetch(lut, ivec2(0, row), 0).r;
  if (x <= p.x) return texelFetch(lut, ivec2(0, row), 0).r + (x - p.x) * p.z;
  if (x >= p.y) return texelFetch(lut, ivec2(n - 1, row), 0).r + (x - p.y) * p.w;
  float t = (x - p.x) / span * float(n - 1);
  int i = int(floor(t));
  float f = t - float(i);
  float a = texelFetch(lut, ivec2(i, row), 0).r;
  float b = texelFetch(lut, ivec2(min(i + 1, n - 1), row), 0).r;
  return mix(a, b, f);
}
`;
