// GPU tables of curve mappings for the compositor and sequencer. Evaluation lives in
// nodes/curvemap.ts; the curves are stored by the shared curve widget (nodes/curves.ts:
// props.curve_<i> = [x, y, handle, …]).
import type { SocketValue } from '../../data/types';
import { readCurve } from '../../nodes/curves';
import { curveEvaluator, type CurveEval } from '../../nodes/curvemap';

export { curveHandles, curveEvaluator, type CurveEval } from '../../nodes/curvemap';

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
