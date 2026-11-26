// Flat pattern views of sheet metal parts: the flat pattern (src/model/flat-pattern.ts) as a
// drawing view's lines (outline and cuts), its edges for dimensions, and its bend lines with
// their notes. View coordinates are the flat pattern's x and y with y turned down.

import type { EdgeInfo, ProjectionResult } from '../kernel/protocol';
import type { FlatPattern, FlatSeg } from '../model/flat-pattern';
import type { P2 } from './views';

/** A bend centre line in view coordinates. */
export interface FlatBendLine {
  a: P2;
  b: P2;
  up: boolean;
  angle: number;
  radius: number;
}

/** What a flat pattern view draws: its lines, plus the bend lines, or why there is no flat pattern. */
export interface FlatProjection extends ProjectionResult {
  bends?: FlatBendLine[];
  error?: string;
}

const r4 = (v: number) => +v.toFixed(4) || 0;
const V = (p: P2): P2 => [p[0], -p[1]];
const pt = (p: P2) => `${r4(p[0])} ${r4(p[1])}`;

function segPath(s: FlatSeg): string {
  if (s.k === 'line') return `M${pt(V(s.a))}L${pt(V(s.b))}`;
  if (s.k === 'circle') {
    const a = V([s.c[0] + s.r, s.c[1]]), b = V([s.c[0] - s.r, s.c[1]]);
    return `M${pt(a)}A${r4(s.r)} ${r4(s.r)} 0 1 0 ${pt(b)}A${r4(s.r)} ${r4(s.r)} 0 1 0 ${pt(a)}`;
  }
  // Counter-clockwise with y up is clockwise with y down: SVG's sweep flag 0.
  let sweep = s.a1 - s.a0;
  while (sweep <= 0) sweep += 2 * Math.PI;
  while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
  const a = V([s.c[0] + s.r * Math.cos(s.a0), s.c[1] + s.r * Math.sin(s.a0)]);
  const b = V([s.c[0] + s.r * Math.cos(s.a1), s.c[1] + s.r * Math.sin(s.a1)]);
  return `M${pt(a)}A${r4(s.r)} ${r4(s.r)} 0 ${sweep > Math.PI ? 1 : 0} 0 ${pt(b)}`;
}

/** The flat pattern as a view's projection (id: the view's key); without one, the reason. */
export function flatProjection(id: string, f: FlatPattern | null, error?: string): FlatProjection {
  if (!f) return { id, visible: [], hidden: [], bounds: null, bends: [], error: error ?? 'The part cannot be flattened' };
  return {
    id,
    visible: f.loops.flatMap((l) => l.segs.map(segPath)),
    hidden: [],
    bounds: [r4(f.min[0]), r4(-f.max[1]), r4(f.max[0]), r4(-f.min[1])],
    bends: f.bends.map((b) => ({ a: V(b.a), b: V(b.b), up: b.up, angle: b.angle, radius: b.radius })),
  };
}

/**
 * The flat pattern's outline and cut edges as model edges of the view (in the plane z = 0, so
 * the front view direction sees them as the flat pattern shows), named "flat:<loop>:<segment>"
 * for dimensions and centre marks.
 */
export function flatEdges(f: FlatPattern | null): EdgeInfo[] {
  if (!f) return [];
  const out: EdgeInfo[] = [];
  const P = (p: P2): [number, number, number] => [p[0], p[1], 0];
  f.loops.forEach((l, i) => l.segs.forEach((s, j) => {
    const name = `flat:${i}:${j}`;
    // Two faces: a drawing leaves out edges with one face (seams).
    if (s.k === 'line') {
      const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
      if (len < 1e-9) return;
      out.push({ name, type: 'line', a: P(s.a), b: P(s.b), mid: P([(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2]), length: len, faces: [0, 1], dir: [(s.b[0] - s.a[0]) / len, (s.b[1] - s.a[1]) / len, 0] });
    } else if (s.k === 'circle') {
      const a = P([s.c[0] + s.r, s.c[1]]);
      out.push({ name, type: 'circle', a, b: a, mid: P([s.c[0] - s.r, s.c[1]]), length: 2 * Math.PI * s.r, faces: [0, 1], center: P(s.c), axis: [0, 0, 1], radius: s.r });
    } else {
      let sweep = s.a1 - s.a0;
      while (sweep <= 0) sweep += 2 * Math.PI;
      const at = (t: number): P2 => [s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)];
      out.push({ name, type: 'circle', a: P(at(s.a0)), b: P(at(s.a0 + sweep)), mid: P(at(s.a0 + sweep / 2)), length: sweep * s.r, faces: [0, 1], center: P(s.c), axis: [0, 0, 1], radius: s.r });
    }
  }));
  return out;
}
