// Particle hair paths: strands smoothed and subdivided for display and rendering (Path ▸ Steps,
// B-Spline), and their thickness along the strand (Hair Shape: root / tip diameter, shape).

/**
 * Subdivide every strand (`per` points each) into `2^steps` pieces per segment. Paths go through
 * their keys (Catmull-Rom) or, with B-Spline, are smoothed between them (ends kept).
 */
export function smoothStrands(points: Float32Array, per: number, steps: number, bspline: boolean): { points: Float32Array; per: number } {
  const sub = 1 << Math.max(0, Math.min(6, Math.round(steps)));
  if (sub <= 1 && !bspline) return { points, per };
  const strands = points.length / (per * 3);
  const seg = per - 1;
  const np = seg * sub + 1;
  const out = new Float32Array(strands * np * 3);
  const P = (s: number, k: number, c: number) => points[(s * per + Math.max(0, Math.min(seg, k))) * 3 + c];
  for (let s = 0; s < strands; s++) {
    let w = s * np * 3;
    for (let k = 0; k < seg; k++)
      for (let j = 0; j < sub; j++) {
        const t = j / sub;
        for (let c = 0; c < 3; c++) {
          const p0 = P(s, k - 1, c),
            p1 = P(s, k, c),
            p2 = P(s, k + 1, c),
            p3 = P(s, k + 2, c);
          let v: number;
          if (bspline) {
            // uniform cubic B-spline (approximating), clamped at the ends by the repeated keys
            const t2 = t * t,
              t3 = t2 * t;
            v = ((1 - t) ** 3 * p0 + (3 * t3 - 6 * t2 + 4) * p1 + (-3 * t3 + 3 * t2 + 3 * t + 1) * p2 + t3 * p3) / 6;
            if (k === 0 && j === 0) v = p1;
          } else {
            // Catmull-Rom through the keys
            const t2 = t * t,
              t3 = t2 * t;
            v = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
          }
          out[w + c] = v;
        }
        w += 3;
      }
    for (let c = 0; c < 3; c++) out[w + c] = P(s, seg, c);
  }
  return { points: out, per: np };
}

/** Radius at each of `per` points of a strand (Hair Shape settings). */
export function strandRadii(per: number, s: { root_radius?: number; tip_radius?: number; radius_scale?: number; shape?: number; use_close_tip?: boolean }): Float32Array {
  const root = s.root_radius ?? 1,
    tip = s.tip_radius ?? 0,
    scale = s.radius_scale ?? 0.01,
    shape = Math.max(-0.999, Math.min(0.999, s.shape ?? 0));
  // shape bends the change from root to tip (positive: thick for longer, negative: thin sooner)
  const e = shape >= 0 ? 1 + shape * 4 : 1 / (1 - shape * 4);
  const r = new Float32Array(per);
  for (let k = 0; k < per; k++) {
    const u = per > 1 ? k / (per - 1) : 0;
    const f = 1 - Math.pow(1 - u, 1 / e);
    r[k] = 0.5 * scale * (root + (tip - root) * f);
  }
  if (s.use_close_tip !== false && per > 1) r[per - 1] = 0;
  return r;
}
