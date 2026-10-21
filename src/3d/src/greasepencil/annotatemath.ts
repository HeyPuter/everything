// Annotation geometry (pure, unit tested): arrow heads of straight lines, erasing the parts of
// strokes inside a circle, and the lazy-mouse stabilizer.
import type { AnnotationArrow, AnnotationStroke } from '../editors/view3d/tools3d';

/** Screen-space arrow head polygons / lines at `tip`, pointing along (dx, dy). */
export function arrowShape(style: AnnotationArrow | undefined, tip: { x: number; y: number }, dx: number, dy: number, size: number): { kind: 'fill' | 'line'; pts: [number, number][] } | null {
  if (!style || style === 'NONE') return null;
  const l = Math.hypot(dx, dy);
  if (l < 1e-6) return null;
  const ux = dx / l,
    uy = dy / l;
  const nx = -uy,
    ny = ux;
  const back = (k: number, side: number): [number, number] => [tip.x - ux * size * k + nx * size * side, tip.y - uy * size * k + ny * size * side];
  switch (style) {
    case 'ARROW':
      return {
        kind: 'fill',
        pts: [[tip.x + ux * size * 0.15, tip.y + uy * size * 0.15], back(1, 0.55), back(1, -0.55)],
      };
    case 'ARROW_OPEN':
      return {
        kind: 'line',
        pts: [back(1, 0.6), [tip.x, tip.y], back(1, -0.6)],
      };
    case 'ARROW_OPEN_INVERTED':
      return { kind: 'line', pts: [back(0, 0.6), back(0, -0.6)] };
    case 'DIAMOND': {
      const s = size * 0.45;
      return {
        kind: 'fill',
        pts: [
          [tip.x + ux * s + nx * s, tip.y + uy * s + ny * s],
          [tip.x - ux * s + nx * s, tip.y - uy * s + ny * s],
          [tip.x - ux * s - nx * s, tip.y - uy * s - ny * s],
          [tip.x + ux * s - nx * s, tip.y + uy * s - ny * s],
        ],
      };
    }
  }
  return null;
}

/**
 * Erase the parts of strokes inside a screen circle: segments are cut where they enter and leave
 * it, pieces with fewer than two points are dropped. `screen` maps a world point index of a
 * stroke to pixels. Returns null when nothing changed.
 */
export function eraseInCircle(
  strokes: AnnotationStroke[],
  screen: (p: number[]) => { x: number; y: number; z: number },
  cx: number,
  cy: number,
  r: number,
  skip: (s: AnnotationStroke) => boolean,
): AnnotationStroke[] | null {
  let changed = false;
  const out: AnnotationStroke[] = [];
  const r2 = r * r;
  for (const s of strokes) {
    if (skip(s)) {
      out.push(s);
      continue;
    }
    const n = s.points.length / 3;
    const P = (i: number) => [s.points[i * 3], s.points[i * 3 + 1], s.points[i * 3 + 2]];
    const S = Array.from({ length: n }, (_, i) => screen(P(i)));
    const inside = S.map((q) => q.z <= 1 && (q.x - cx) ** 2 + (q.y - cy) ** 2 <= r2);
    const pieces: number[][] = [];
    let cur: number[] = [];
    const flush = () => {
      if (cur.length >= 6) pieces.push(cur);
      cur = [];
    };
    let hit = inside.some(Boolean);
    for (let i = 0; i < n; i++) {
      if (!inside[i]) cur.push(...P(i));
      if (i + 1 >= n) break;
      // intersections of segment i → i+1 with the circle (screen space, linear in world)
      const a = S[i],
        b = S[i + 1];
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const fx = a.x - cx,
        fy = a.y - cy;
      const A = dx * dx + dy * dy,
        B = 2 * (fx * dx + fy * dy),
        C = fx * fx + fy * fy - r2;
      const disc = B * B - 4 * A * C;
      if (A < 1e-9 || disc <= 0) {
        if (inside[i] !== inside[i + 1]) flush();
        continue;
      }
      const sq = Math.sqrt(disc);
      const t0 = (-B - sq) / (2 * A),
        t1 = (-B + sq) / (2 * A);
      const pa = P(i),
        pb = P(i + 1);
      const at = (t: number) => [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t];
      if (!inside[i] && t0 > 0 && t0 < 1) {
        cur.push(...at(t0));
        flush();
        hit = true;
      } else if (inside[i] !== inside[i + 1]) flush();
      if (!inside[i + 1] && t1 > 0 && t1 < 1) {
        flush();
        cur.push(...at(t1));
        hit = true;
      }
    }
    flush();
    if (!hit) {
      out.push(s);
      continue;
    }
    changed = true;
    pieces.forEach((pts, k) =>
      out.push({
        ...s,
        points: pts,
        ...(k > 0 ? { arrow_start: 'NONE' as AnnotationArrow } : {}),
        ...(k < pieces.length - 1 ? { arrow_end: 'NONE' as AnnotationArrow } : {}),
      }),
    );
  }
  return changed ? out : null;
}

/** Lazy-mouse stabilizer: the drawn point trails the pointer by `radius` pixels, eased by `factor`. */
export function stabilize(prev: { x: number; y: number }, target: { x: number; y: number }, radius: number, factor: number): { x: number; y: number } {
  const dx = target.x - prev.x,
    dy = target.y - prev.y;
  const d = Math.hypot(dx, dy);
  if (d <= radius) return prev;
  const move = (d - radius) * (1 - Math.min(0.95, Math.max(0, factor)) * 0.5);
  return { x: prev.x + (dx / d) * move, y: prev.y + (dy / d) * move };
}
