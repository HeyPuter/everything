// 2D annotation strokes (pure): data types, distances and erasing.

export interface Annotation2DStroke {
  /** flat x, y pairs in frame space (0..1, y up) */
  points: number[];
  color: [number, number, number];
  thickness: number;
}

/** Data that keeps 2D annotations (an image, a movie clip, the scene). */
export interface Annotation2DOwner {
  annotations_2d?: Annotation2DStroke[];
}

/** Pixel distance from (x, y) to segment a–b. */
export function segmentDistance(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax,
    dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/**
 * Erase the parts of strokes near a screen point: points within `radius` are removed and strokes
 * split where they were. `toScreen` maps stroke points to screen pixels. Returns whether anything
 * changed.
 */
export function eraseAt(strokes: Annotation2DStroke[], x: number, y: number, radius: number, toScreen: (u: number, v: number) => [number, number]): boolean {
  let changed = false;
  const out: Annotation2DStroke[] = [];
  for (const s of strokes) {
    const n = s.points.length / 2;
    const keep: boolean[] = [];
    for (let i = 0; i < n; i++) {
      const [px, py] = toScreen(s.points[i * 2], s.points[i * 2 + 1]);
      keep.push(Math.hypot(px - x, py - y) > radius);
    }
    // a two-point line whose middle passes under the eraser goes as a whole
    if (n === 2 && keep[0] && keep[1]) {
      const [ax, ay] = toScreen(s.points[0], s.points[1]),
        [bx, by] = toScreen(s.points[2], s.points[3]);
      if (segmentDistance(x, y, ax, ay, bx, by) <= radius) keep[0] = keep[1] = false;
    }
    if (keep.every(Boolean)) {
      out.push(s);
      continue;
    }
    changed = true;
    let run: number[] = [];
    const flush = () => {
      if (run.length >= 4) out.push({ ...s, points: run });
      run = [];
    };
    for (let i = 0; i < n; i++) {
      if (keep[i]) run.push(s.points[i * 2], s.points[i * 2 + 1]);
      else flush();
    }
    flush();
  }
  if (changed) strokes.splice(0, strokes.length, ...out);
  return changed;
}

