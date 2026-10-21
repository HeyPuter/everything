// Wireframe threshold (Overlays ▸ Geometry ▸ Wireframe): at 1 every edge is drawn; lower values
// keep only the edges whose faces meet at a sharper angle (plus open and non-manifold edges);
// at 0 only edges of 90° or more remain (a cube keeps all of its edges).
import { edgeTopology, faceNormals } from '../../mesh/mesh';
import type { MeshData } from '../../data/types';

type MeshLike = Pick<MeshData, 'offsets' | 'indices' | 'positions'>;

/** Minimum angle between the face normals of a drawn edge for a threshold in [0, 1]. */
export function thresholdAngle(threshold: number): number {
  const t = Math.max(0, Math.min(1, threshold));
  return ((1 - t) * Math.PI) / 2;
}

/** Vertex pairs (flat) of the edges shown at the threshold. */
export function thresholdEdges(m: MeshLike, threshold: number): Uint32Array {
  const et = edgeTopology(m);
  if (threshold >= 1) return et.verts;
  const fn = faceNormals(m);
  const minAngle = thresholdAngle(threshold);
  const cosMax = Math.cos(minAngle);
  const out: number[] = [];
  for (let e = 0; e < et.count; e++) {
    const a = et.faceOffsets[e],
      b = et.faceOffsets[e + 1];
    let keep = b - a !== 2;
    if (!keep) {
      const f0 = et.faces[a],
        f1 = et.faces[a + 1];
      const d = fn[f0 * 3] * fn[f1 * 3] + fn[f0 * 3 + 1] * fn[f1 * 3 + 1] + fn[f0 * 3 + 2] * fn[f1 * 3 + 2];
      // angle ≥ minAngle  ⇔  cos(angle) ≤ cos(minAngle)
      keep = d <= cosMax + 1e-6;
    }
    if (keep) out.push(et.verts[e * 2], et.verts[e * 2 + 1]);
  }
  return new Uint32Array(out);
}
