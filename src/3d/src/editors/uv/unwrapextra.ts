// Unwrap follow-ups: keep pinned UVs where they were (each island is moved, rotated and scaled
// onto its pins) and the "Minimum Stretch" method (relaxing the fresh unwrap).
import type { MeshData } from '../../data/types';
import { UVTopo, isPinned } from './uvcore';
import { islandCorners, minimizeStretch } from './uvalgo';

type V2 = [number, number];

/** Similarity transform (rotation, uniform scale, translation) mapping src points onto dst. */
export function similarityFit(src: V2[], dst: V2[]): (x: number, y: number) => V2 {
  const n = src.length;
  let sx = 0,
    sy = 0,
    dx = 0,
    dy = 0;
  for (let i = 0; i < n; i++) {
    sx += src[i][0] / n;
    sy += src[i][1] / n;
    dx += dst[i][0] / n;
    dy += dst[i][1] / n;
  }
  let a = 0,
    b = 0,
    ss = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i][0] - sx,
      y = src[i][1] - sy;
    const X = dst[i][0] - dx,
      Y = dst[i][1] - dy;
    a += x * X + y * Y;
    b += x * Y - y * X;
    ss += x * x + y * y;
  }
  if (ss < 1e-20) return (x, y) => [x - sx + dx, y - sy + dy];
  a /= ss;
  b /= ss;
  return (x, y) => {
    const px = x - sx,
      py = y - sy;
    return [dx + a * px - b * py, dy + b * px + a * py];
  };
}

/**
 * After an unwrap replaced the UVs of `faces`: fit every island holding pinned UVs back onto
 * the pins' previous positions, then optionally relax unpinned UVs to reduce stretch.
 */
export function afterUnwrap(me: MeshData, before: ArrayLike<number>, faces: number[], minimizeIterations = 0): boolean {
  const pinned = me.uv_pin && me.uv_pin.length === me.indices.length;
  if (!pinned && minimizeIterations <= 0) return false;
  const t = new UVTopo({ me, faces, sync: false });
  const uvs = new Float32Array(me.uvs);
  if (pinned) {
    for (const isl of t.islandFaces()) {
      const corners = islandCorners(t, isl);
      const pins = corners.filter((c) => isPinned(me, c));
      if (!pins.length) continue;
      const src = pins.map((c) => [uvs[c * 2], uvs[c * 2 + 1]] as V2);
      const dst = pins.map((c) => [before[c * 2], before[c * 2 + 1]] as V2);
      const tf = similarityFit(src, dst);
      for (const c of corners) {
        const [x, y] = tf(uvs[c * 2], uvs[c * 2 + 1]);
        uvs[c * 2] = x;
        uvs[c * 2 + 1] = y;
      }
      for (const c of pins) {
        uvs[c * 2] = before[c * 2];
        uvs[c * 2 + 1] = before[c * 2 + 1];
      }
    }
  }
  if (minimizeIterations > 0) {
    me.uvs = uvs;
    const t2 = new UVTopo({ me, faces, sync: false });
    const movable = new Set<number>();
    for (let id = 0; id < t2.vertCount; id++) if (!t2.vertCorners[id].some((c) => isPinned(me, c))) movable.add(id);
    minimizeStretch(t2, uvs, movable, minimizeIterations);
  }
  me.uvs = uvs;
  return true;
}
