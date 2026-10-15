// Gesture shapes (box, lasso, line, polyline) in viewport pixels: hit tests and conversion
// to / from operator properties. Pure helpers without UI dependencies.
import type { PropDef } from '../app/app';

export type GestureShape = 'BOX' | 'LASSO' | 'LINE' | 'POLYLINE';

export interface Pt {
  x: number;
  y: number;
}

/** Shape geometry in viewport pixels. */
export type Gesture =
  | { kind: 'BOX'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'LASSO' | 'POLYLINE'; pts: Pt[] }
  | { kind: 'LINE'; a: Pt; b: Pt; flip: boolean; limit: boolean };

/** Point-in-shape test (for LINE: the side of the line the gesture acts on). */
export function gestureTest(g: Gesture): (x: number, y: number) => boolean {
  if (g.kind === 'BOX') {
    const ax = Math.min(g.x0, g.x1),
      bx = Math.max(g.x0, g.x1),
      ay = Math.min(g.y0, g.y1),
      by = Math.max(g.y0, g.y1);
    return (x, y) => x >= ax && x <= bx && y >= ay && y <= by;
  }
  if (g.kind === 'LINE') {
    const dx = g.b.x - g.a.x,
      dy = g.b.y - g.a.y;
    const len2 = dx * dx + dy * dy || 1;
    const s = g.flip ? -1 : 1;
    return (x, y) => {
      const cross = dx * (y - g.a.y) - dy * (x - g.a.x);
      if (cross * s < 0) return false;
      if (!g.limit) return true;
      const t = ((x - g.a.x) * dx + (y - g.a.y) * dy) / len2;
      return t >= 0 && t <= 1;
    };
  }
  const pts = g.pts;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return (x, y) => {
    if (x < minX || x > maxX || y < minY || y > maxY) return false;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const pi = pts[i],
        pj = pts[j];
      if (pi.y > y !== pj.y > y && x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x) inside = !inside;
    }
    return inside;
  };
}

// ---------------------------------------------------------------------------
// props <-> gesture

export const BOX_PROPS: PropDef[] = [
  { id: 'xmin', label: 'X Min', type: 'int', default: 0, hidden: true },
  { id: 'xmax', label: 'X Max', type: 'int', default: 0, hidden: true },
  { id: 'ymin', label: 'Y Min', type: 'int', default: 0, hidden: true },
  { id: 'ymax', label: 'Y Max', type: 'int', default: 0, hidden: true },
];
export const PATH_PROPS: PropDef[] = [{ id: 'path', label: 'Path', type: 'string', default: '[]', hidden: true }];
export const LINE_PROPS: PropDef[] = [
  { id: 'xstart', label: 'X Start', type: 'int', default: 0, hidden: true },
  { id: 'xend', label: 'X End', type: 'int', default: 0, hidden: true },
  { id: 'ystart', label: 'Y Start', type: 'int', default: 0, hidden: true },
  { id: 'yend', label: 'Y End', type: 'int', default: 0, hidden: true },
  { id: 'flip', label: 'Flip Side', type: 'bool', default: false },
  { id: 'use_limit_to_segment', label: 'Limit to Segment', type: 'bool', default: false },
];

export function shapeProps(kind: GestureShape): PropDef[] {
  return kind === 'BOX' ? BOX_PROPS : kind === 'LINE' ? LINE_PROPS : PATH_PROPS;
}

export function gestureFromProps(kind: GestureShape, p: Record<string, unknown>): Gesture | null {
  if (kind === 'BOX') {
    const g = { kind, x0: p.xmin as number, y0: p.ymin as number, x1: p.xmax as number, y1: p.ymax as number } as const;
    return g.x1 > g.x0 && g.y1 > g.y0 ? g : null;
  }
  if (kind === 'LINE') {
    const a = { x: p.xstart as number, y: p.ystart as number },
      b = { x: p.xend as number, y: p.yend as number };
    if (a.x === b.x && a.y === b.y) return null;
    return { kind, a, b, flip: !!p.flip, limit: !!p.use_limit_to_segment };
  }
  let pts: Pt[] = [];
  try {
    pts = (JSON.parse(String(p.path ?? '[]')) as [number, number][]).map(([x, y]) => ({ x, y }));
  } catch {
    return null;
  }
  return pts.length >= 3 ? { kind, pts } : null;
}

export function propsFromGesture(g: Gesture): Record<string, unknown> {
  if (g.kind === 'BOX')
    return {
      xmin: Math.round(Math.min(g.x0, g.x1)),
      xmax: Math.round(Math.max(g.x0, g.x1)),
      ymin: Math.round(Math.min(g.y0, g.y1)),
      ymax: Math.round(Math.max(g.y0, g.y1)),
    };
  if (g.kind === 'LINE') return { xstart: Math.round(g.a.x), ystart: Math.round(g.a.y), xend: Math.round(g.b.x), yend: Math.round(g.b.y), flip: g.flip, use_limit_to_segment: g.limit };
  return { path: JSON.stringify(g.pts.map((q) => [Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10])) };
}

