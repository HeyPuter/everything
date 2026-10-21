// Pure helpers for brush strokes: recorded stroke samples and paint curves.
import type { StrokePoint } from './stroke';

/** One recorded stroke sample, as scripts pass it (`mouse` in region pixels, y up; or a `location`). */
export interface StrokeItem {
  mouse?: [number, number];
  location?: [number, number, number];
  pressure?: number;
  size?: number;
  pen_flip?: boolean;
  time?: number;
  is_start?: boolean;
}

/** Convert script stroke items into viewport points (top-left origin). Pure apart from the projection callback. */
export function strokePoints(items: StrokeItem[], height: number, project: (p: [number, number, number]) => { x: number; y: number; z: number } | null): StrokePoint[] {
  const out: StrokePoint[] = [];
  for (const it of items) {
    let x: number, y: number;
    if (it.mouse && it.mouse.length >= 2 && (it.mouse[0] !== 0 || it.mouse[1] !== 0 || !it.location)) {
      x = it.mouse[0];
      y = height - it.mouse[1];
    } else if (it.location) {
      const q = project(it.location);
      if (!q || q.z < -1 || q.z > 1) continue;
      x = q.x;
      y = q.y;
    } else continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({ x, y, pressure: it.pressure === undefined ? 1 : Math.max(0, Math.min(1, it.pressure)) });
  }
  return out;
}


// ---------------------------------------------------------------------------
// paint curves: 2D Bézier curves in viewport pixels (top-left origin) that a stroke follows

export type Vec2 = [number, number];

export interface PaintCurvePoint {
  /** handle before the point, the point, handle after the point */
  h1: Vec2;
  co: Vec2;
  h2: Vec2;
  /** selection of h1 / co / h2 */
  select: [boolean, boolean, boolean];
}

export interface PaintCurveData {
  id: string;
  name: string;
  points: PaintCurvePoint[];
  /** index of the point new points are added after (-1: at the end) */
  add_index: number;
  use_fake_user?: boolean;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Point on the cubic segment between two curve points. */
export function bezierAt(a: PaintCurvePoint, b: PaintCurvePoint, t: number): Vec2 {
  const u = 1 - t;
  const k0 = u * u * u,
    k1 = 3 * u * u * t,
    k2 = 3 * u * t * t,
    k3 = t * t * t;
  return [k0 * a.co[0] + k1 * a.h2[0] + k2 * b.h1[0] + k3 * b.co[0], k0 * a.co[1] + k1 * a.h2[1] + k2 * b.h1[1] + k3 * b.co[1]];
}

/** The curve as a polyline (`steps` samples per segment). A single point gives itself. */
export function curvePolyline(points: PaintCurvePoint[], steps = 32): Vec2[] {
  if (!points.length) return [];
  if (points.length === 1) return [[...points[0].co]];
  const out: Vec2[] = [[...points[0].co]];
  for (let i = 0; i + 1 < points.length; i++) for (let s = 1; s <= steps; s++) out.push(bezierAt(points[i], points[i + 1], s / steps));
  return out;
}

/** Resample a polyline at equal distances (`step` pixels), keeping both ends. */
export function resamplePolyline(line: Vec2[], step: number): Vec2[] {
  if (line.length < 2) return line.map((p) => [...p] as Vec2);
  const out: Vec2[] = [[...line[0]]];
  let carry = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = line[i],
      [bx, by] = line[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    if (len <= 0) continue;
    let d = step - carry;
    while (d <= len) {
      const t = d / len;
      out.push([lerp(ax, bx, t), lerp(ay, by, t)]);
      d += step;
    }
    carry = len - (d - step);
  }
  const last = line[line.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > 1e-6) out.push([...last]);
  return out;
}

/** A new curve point at `at`, its handles along the direction from `prev` (or horizontal). */
export function makeCurvePoint(at: Vec2, prev: Vec2 | null, next: Vec2 | null = null): PaintCurvePoint {
  let dx = 1,
    dy = 0,
    len = 40;
  const ref = prev ?? next;
  if (ref) {
    const ex = prev ? at[0] - prev[0] : next![0] - at[0],
      ey = prev ? at[1] - prev[1] : next![1] - at[1];
    const d = Math.hypot(ex, ey);
    if (d > 1e-6) {
      dx = ex / d;
      dy = ey / d;
      len = Math.max(8, Math.min(80, d / 3));
    }
  }
  return { h1: [at[0] - dx * len, at[1] - dy * len], co: [at[0], at[1]], h2: [at[0] + dx * len, at[1] + dy * len], select: [true, true, true] };
}

/** Closest point or handle within `radius` pixels: [point index, 0 h1 / 1 co / 2 h2], or null. */
export function pickCurvePoint(points: PaintCurvePoint[], x: number, y: number, radius = 10): [number, number] | null {
  let best: [number, number] | null = null;
  let bd = radius * radius + 1e-9;
  points.forEach((p, i) => {
    // the point itself is tested first so it wins ties with its handles
    for (const k of [1, 0, 2]) {
      const q = k === 0 ? p.h1 : k === 1 ? p.co : p.h2;
      const d = (q[0] - x) ** 2 + (q[1] - y) ** 2;
      if (d < bd) {
        bd = d;
        best = [i, k];
      }
    }
  });
  return best;
}

/** Move a point (with its handles) or one handle; `align` mirrors the other handle around the point. */
export function moveCurveElement(p: PaintCurvePoint, which: number, dx: number, dy: number, align: boolean) {
  if (which === 1) {
    for (const q of [p.h1, p.co, p.h2]) {
      q[0] += dx;
      q[1] += dy;
    }
    return;
  }
  const h = which === 0 ? p.h1 : p.h2;
  h[0] += dx;
  h[1] += dy;
  if (align) {
    const o = which === 0 ? p.h2 : p.h1;
    o[0] = 2 * p.co[0] - h[0];
    o[1] = 2 * p.co[1] - h[1];
  }
}
