// Parent matrices for objects parented to one vertex or to a triangle of three vertices.
import { Matrix4, Vector3 } from 'three';

/**
 * Local (parent-space) matrix of a vertex parent: a translation to the vertex, or for three
 * vertices a frame at their centroid with Z along the triangle normal and X along v0 → v1.
 */
export function vertexParentMatrix(positions: ArrayLike<number>, verts: number[], out = new Matrix4()): Matrix4 | null {
  const n = positions.length / 3;
  const p = (i: number) => new Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  if (verts.length >= 3 && verts.slice(0, 3).every((v) => v >= 0 && v < n)) {
    const a = p(verts[0]),
      b = p(verts[1]),
      c = p(verts[2]);
    const center = a.clone().add(b).add(c).multiplyScalar(1 / 3);
    const x = b.clone().sub(a);
    const z = x.clone().cross(c.clone().sub(a));
    if (z.lengthSq() < 1e-16 || x.lengthSq() < 1e-16) return out.makeTranslation(center.x, center.y, center.z);
    x.normalize();
    z.normalize();
    const y = z.clone().cross(x);
    return out.makeBasis(x, y, z).setPosition(center);
  }
  const v = verts[0] ?? 0;
  if (v < 0 || v >= n) return null;
  return out.makeTranslation(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
}
