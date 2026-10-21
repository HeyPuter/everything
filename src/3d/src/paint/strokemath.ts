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

