// Draw brush input processing (pure): the stabilizer (lazy mouse), trimming the overshooting ends
// of a stroke, and seeded per point randomness.

export interface Sample {
  x: number;
  y: number;
  pressure: number;
}

/**
 * Lazy mouse: the drawing point trails the pointer by `radius` pixels and eases toward it by
 * (1 - `factor`) each step. Returns the stabilized position for the next pointer position.
 */
export function stabilize(prev: { x: number; y: number }, cursor: { x: number; y: number }, radius: number, factor: number): { x: number; y: number } {
  const dx = cursor.x - prev.x,
    dy = cursor.y - prev.y;
  const d = Math.hypot(dx, dy);
  if (d <= radius) return { ...prev };
  const tx = cursor.x - (dx / d) * radius,
    ty = cursor.y - (dy / d) * radius;
  const k = 1 - Math.max(0, Math.min(0.99, factor));
  return { x: prev.x + (tx - prev.x) * Math.max(k, 0.05), y: prev.y + (ty - prev.y) * Math.max(k, 0.05) };
}

/** Intersection of segments p1-p2 and p3-p4: [t on the first, u on the second] or null. */
function cross(p1: Sample, p2: Sample, p3: Sample, p4: Sample): [number, number] | null {
  const rx = p2.x - p1.x,
    ry = p2.y - p1.y,
    sx = p4.x - p3.x,
    sy = p4.y - p3.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((p3.x - p1.x) * sy - (p3.y - p1.y) * sx) / den;
  const u = ((p3.x - p1.x) * ry - (p3.y - p1.y) * rx) / den;
  return t > 0 && t < 1 && u > 0 && u < 1 ? [t, u] : null;
}

const lerpS = (a: Sample, b: Sample, t: number): Sample => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, pressure: a.pressure + (b.pressure - a.pressure) * t });

/**
 * Trim: a stroke that crosses itself loses the loose ends beyond its first and last crossing
 * (the tails that overshoot when closing a shape).
 */
export function trimEnds(s: Sample[]): Sample[] {
  const n = s.length;
  if (n < 4) return s;
  let first: { i: number; t: number } | null = null,
    last: { j: number; u: number } | null = null;
  for (let i = 0; i + 1 < n; i++)
    for (let j = i + 2; j + 1 < n; j++) {
      const c = cross(s[i], s[i + 1], s[j], s[j + 1]);
      if (!c) continue;
      if (!first || i < first.i || (i === first.i && c[0] < first.t)) first = { i, t: c[0] };
      if (!last || j > last.j || (j === last.j && c[1] > last.u)) last = { j, u: c[1] };
    }
  if (!first || !last) return s;
  const out = [lerpS(s[first.i], s[first.i + 1], first.t), ...s.slice(first.i + 1, last.j + 1), lerpS(s[last.j], s[last.j + 1], last.u)];
  return out.length >= 2 ? out : s;
}

/** Deterministic noise in [-1, 1] for (seed, index). */
export function noise(seed: number, i: number): number {
  let h = (seed * 374761393 + i * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}
