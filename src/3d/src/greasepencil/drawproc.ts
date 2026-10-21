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

/** Radius factor of a pen nib: 1 - factor where the direction runs along the nib angle, 1 across it. */
export function nibFactor(dir: number, angle: number, factor: number): number {
  return Math.max(0.01, 1 - Math.max(0, Math.min(1, factor)) * Math.abs(Math.cos(dir - angle)));
}

/** Brush blend modes of vertex painting (`bpy` brush.blend names). */
export const VERTEX_BLEND_MODES: [string, string][] = [
  ['MIX', 'Mix'],
  ['DARKEN', 'Darken'],
  ['MUL', 'Multiply'],
  ['LIGHTEN', 'Lighten'],
  ['SCREEN', 'Screen'],
  ['ADD', 'Add'],
  ['SUB', 'Subtract'],
  ['OVERLAY', 'Overlay'],
  ['DIFFERENCE', 'Difference'],
  ['HUE', 'Hue'],
  ['SATURATION', 'Saturation'],
  ['COLOR', 'Color'],
  ['LUMINOSITY', 'Value'],
];

function toHsv(c: number[]): [number, number, number] {
  const mx = Math.max(c[0], c[1], c[2]),
    mn = Math.min(c[0], c[1], c[2]);
  const d = mx - mn;
  let hh = 0;
  if (d > 1e-9) {
    if (mx === c[0]) hh = ((c[1] - c[2]) / d) % 6;
    else if (mx === c[1]) hh = (c[2] - c[0]) / d + 2;
    else hh = (c[0] - c[1]) / d + 4;
    hh /= 6;
    if (hh < 0) hh += 1;
  }
  return [hh, mx > 0 ? d / mx : 0, mx];
}

function fromHsv(hh: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(hh * 6),
    f = hh * 6 - i;
  const p = v * (1 - s),
    q = v * (1 - f * s),
    t = v * (1 - (1 - f) * s);
  switch (((i % 6) + 6) % 6) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}

/** The color a brush in `mode` paints over `base` (rgb 0..1): the stroke then mixes toward it. */
export function blendColor(mode: string, base: number[], paint: number[]): [number, number, number] {
  const ch = (fn: (a: number, b: number) => number): [number, number, number] => [0, 1, 2].map((k) => Math.max(0, Math.min(1, fn(base[k], paint[k])))) as [number, number, number];
  switch (mode) {
    case 'DARKEN':
      return ch(Math.min);
    case 'MUL':
      return ch((a, b) => a * b);
    case 'LIGHTEN':
      return ch(Math.max);
    case 'SCREEN':
      return ch((a, b) => 1 - (1 - a) * (1 - b));
    case 'ADD':
      return ch((a, b) => a + b);
    case 'SUB':
      return ch((a, b) => a - b);
    case 'OVERLAY':
      return ch((a, b) => (a < 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b)));
    case 'DIFFERENCE':
      return ch((a, b) => Math.abs(a - b));
    case 'HUE':
    case 'SATURATION':
    case 'COLOR':
    case 'LUMINOSITY': {
      const B = toHsv(base),
        P = toHsv(paint);
      if (mode === 'HUE') return fromHsv(P[0], B[1], B[2]);
      if (mode === 'SATURATION') return fromHsv(B[0], P[1], B[2]);
      if (mode === 'COLOR') return fromHsv(P[0], P[1], B[2]);
      return fromHsv(B[0], B[1], P[2]);
    }
  }
  return [paint[0], paint[1], paint[2]];
}
