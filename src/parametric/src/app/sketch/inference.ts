// Sketch inference: snapping the cursor to existing points, midpoints,
// curves, the origin, horizontal/vertical directions and alignment with
// other points. The kind of snap decides which relation gets added when a
// point is committed.

import type { Id, SkCurve, SketchFeature } from '../../model/types';
import { type Vec2, dist2 } from '../../math/vec';
import { ORIGIN_ID, SketchIndex, distanceToCurve, pointIdsOf } from '../../sketch/geom';

export type SnapKind = 'none' | 'point' | 'origin' | 'mid' | 'on' | 'h' | 'v' | 'alignX' | 'alignY' | 'center';

export interface Snap {
  p: Vec2;
  raw: Vec2;
  kind: SnapKind;
  pointId?: Id;
  curveId?: Id;
  /** For alignment: the point aligned with (dotted guide). */
  guide?: Vec2;
}

export interface SnapOptions {
  from?: Vec2 | null;
  exclude?: Set<Id>;
  disabled?: boolean;
  /** Tolerance in sketch units (pixel radius times pixel size). */
  tol: number;
}

export function snapPoint(sk: SketchFeature, raw: Vec2, o: SnapOptions): Snap {
  if (o.disabled) return { p: raw, raw, kind: 'none' };
  const ix = new SketchIndex(sk.entities);
  const tol = o.tol;
  const ex = o.exclude ?? new Set<Id>();
  // 1. Existing points (end points, centres, sketch points) and the origin.
  let best: Snap | null = null;
  let bestD = tol;
  if (!ex.has(ORIGIN_ID)) {
    const d = dist2(raw, [0, 0]);
    if (d < bestD) { bestD = d; best = { p: [0, 0], raw, kind: 'origin', pointId: ORIGIN_ID }; }
  }
  const centerIds = new Set<Id>();
  for (const e of sk.entities) if (e.t === 'circle' || e.t === 'arc') centerIds.add(e.c);
  for (const e of sk.entities) {
    if (e.t !== 'point' || ex.has(e.id)) continue;
    const d = dist2(raw, [e.x, e.y]);
    // A real point at the origin (a chain's first point) wins over the origin
    // itself, so drawing back to it closes the chain instead of adding a
    // second point there.
    const atOrigin = best?.kind === 'origin' && Math.hypot(e.x, e.y) <= tol * 1e-6;
    if (d < bestD || atOrigin) { bestD = d; best = { p: [e.x, e.y], raw, kind: centerIds.has(e.id) ? 'center' : 'point', pointId: e.id }; }
  }
  if (best) return best;
  // 2. Midpoints of lines.
  for (const e of sk.entities) {
    if (e.t !== 'line' || ex.has(e.id) || ex.has(e.a) || ex.has(e.b)) continue;
    const a = ix.pt(e.a), b = ix.pt(e.b);
    const m: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const d = dist2(raw, m);
    if (d < bestD * 0.9) { bestD = d; best = { p: m, raw, kind: 'mid', curveId: e.id }; }
  }
  if (best) return best;
  // 3. Horizontal / vertical from the previous point.
  let p: Vec2 = raw;
  let kind: SnapKind = 'none';
  let guide: Vec2 | undefined;
  if (o.from) {
    const dx = raw[0] - o.from[0], dy = raw[1] - o.from[1];
    const len = Math.hypot(dx, dy);
    if (len > tol * 2) {
      const tan = Math.tan((3 * Math.PI) / 180);
      if (Math.abs(dy) < Math.abs(dx) * tan) { p = [raw[0], o.from[1]]; kind = 'h'; }
      else if (Math.abs(dx) < Math.abs(dy) * tan) { p = [o.from[0], raw[1]]; kind = 'v'; }
    }
  }
  // 4. On a curve (only when not already snapped to a direction).
  if (kind === 'none') {
    let bd = tol * 0.8;
    let on: Snap | null = null;
    for (const e of sk.entities) {
      if (e.t === 'point' || ex.has(e.id) || pointIdsOf(e).some((id) => ex.has(id))) continue;
      const r = distanceToCurve(ix, e as SkCurve, raw);
      if (r.d < bd) { bd = r.d; on = { p: r.q, raw, kind: 'on', curveId: e.id }; }
    }
    if (on) return on;
  }
  // 5. Alignment guides with existing points (no relation added).
  if (kind !== 'h' && kind !== 'v') {
    let ax: Snap | null = null, ad = tol * 0.6;
    for (const e of sk.entities) {
      if (e.t !== 'point' || ex.has(e.id)) continue;
      const dX = Math.abs(raw[0] - e.x), dY = Math.abs(raw[1] - e.y);
      if (dX < ad) { ad = dX; ax = { p: [e.x, raw[1]], raw, kind: 'alignX', guide: [e.x, e.y] }; }
      if (dY < ad) { ad = dY; ax = { p: [raw[0], e.y], raw, kind: 'alignY', guide: [e.x, e.y] }; }
    }
    if (ax) return ax;
  }
  return { p, raw, kind, guide };
}

export const SNAP_GLYPH: Partial<Record<SnapKind, string>> = {
  point: 'coincident',
  origin: 'coincident',
  center: 'concentric',
  mid: 'midpoint',
  on: 'coincident',
  h: 'horizontal',
  v: 'vertical',
};
