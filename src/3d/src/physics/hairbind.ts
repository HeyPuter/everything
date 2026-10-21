// Connected hair: each edited strand is bound to the emitter triangle under its root (vertex indices,
// barycentric weights and the triangle's rest positions). When the emitter deforms, every strand
// moves rigidly with the frame of its triangle, so combed hair follows the surface.
import { Vector3 } from 'three';
import type { EvalMesh } from '../eval/types';
import { closestOnTri, triangulate } from './colliders';
import type { EditedHair } from './types';

export interface HairBinding {
  /** vertex count of the mesh the binding was made on (a different count invalidates it) */
  verts: number;
  /** triangle vertex indices per strand (3 each) */
  tri: Int32Array;
  /** barycentric weights of the root per strand (3 each) */
  bary: Float32Array;
  /** rest positions of the triangle's vertices per strand (9 each) */
  rest: Float32Array;
}

const _w = [0, 0, 0];

/** Snap every strand root onto the nearest surface point (moving the whole strand) and bind it there. */
export function bindHairRoots(ed: EditedHair, mesh: EvalMesh): { ed: EditedHair; binding: HairBinding } {
  const P = mesh.positions;
  const tris = triangulate(P, mesh.offsets, mesh.indices);
  const strands = ed.key_offsets.length - 1;
  const co = ed.co.slice();
  const tri = new Int32Array(strands * 3),
    bary = new Float32Array(strands * 3),
    rest = new Float32Array(strands * 9);
  for (let s = 0; s < strands; s++) {
    const r = ed.key_offsets[s] * 3;
    const x = co[r],
      y = co[r + 1],
      z = co[r + 2];
    let best = Infinity,
      bt = -1;
    const bw = [0, 0, 0];
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t] * 3,
        b = tris[t + 1] * 3,
        c = tris[t + 2] * 3;
      closestOnTri(x, y, z, P, a, b, c, _w);
      const qx = P[a] * _w[0] + P[b] * _w[1] + P[c] * _w[2],
        qy = P[a + 1] * _w[0] + P[b + 1] * _w[1] + P[c + 1] * _w[2],
        qz = P[a + 2] * _w[0] + P[b + 2] * _w[1] + P[c + 2] * _w[2];
      const d = (qx - x) ** 2 + (qy - y) ** 2 + (qz - z) ** 2;
      if (d < best) {
        best = d;
        bt = t;
        bw[0] = _w[0];
        bw[1] = _w[1];
        bw[2] = _w[2];
      }
    }
    if (bt < 0) continue;
    const ia = tris[bt],
      ib = tris[bt + 1],
      ic = tris[bt + 2];
    tri.set([ia, ib, ic], s * 3);
    bary.set(bw, s * 3);
    for (let k = 0; k < 3; k++) {
      const v = [ia, ib, ic][k] * 3;
      rest[s * 9 + k * 3] = P[v];
      rest[s * 9 + k * 3 + 1] = P[v + 1];
      rest[s * 9 + k * 3 + 2] = P[v + 2];
    }
    // move the strand so its root sits on the surface
    const qx = P[ia * 3] * bw[0] + P[ib * 3] * bw[1] + P[ic * 3] * bw[2],
      qy = P[ia * 3 + 1] * bw[0] + P[ib * 3 + 1] * bw[1] + P[ic * 3 + 1] * bw[2],
      qz = P[ia * 3 + 2] * bw[0] + P[ib * 3 + 2] * bw[1] + P[ic * 3 + 2] * bw[2];
    const dx = qx - x,
      dy = qy - y,
      dz = qz - z;
    for (let k = ed.key_offsets[s]; k < ed.key_offsets[s + 1]; k++) {
      co[k * 3] += dx;
      co[k * 3 + 1] += dy;
      co[k * 3 + 2] += dz;
    }
  }
  return { ed: { ...ed, co }, binding: { verts: P.length / 3, tri, bary, rest } };
}

/** Orthonormal frame (origin + 3 axes) of a triangle at barycentric weights. */
function frame(p: ArrayLike<number>, a: number, b: number, c: number, w: ArrayLike<number>, wo: number, out: Float64Array) {
  const ox = p[a] * w[wo] + p[b] * w[wo + 1] + p[c] * w[wo + 2],
    oy = p[a + 1] * w[wo] + p[b + 1] * w[wo + 1] + p[c + 1] * w[wo + 2],
    oz = p[a + 2] * w[wo] + p[b + 2] * w[wo + 1] + p[c + 2] * w[wo + 2];
  const e1 = new Vector3(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
  const e2 = new Vector3(p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]);
  const n = new Vector3().crossVectors(e1, e2);
  if (n.lengthSq() < 1e-20 || e1.lengthSq() < 1e-20) return false;
  e1.normalize();
  n.normalize();
  const y = new Vector3().crossVectors(n, e1);
  out.set([ox, oy, oz, e1.x, e1.y, e1.z, y.x, y.y, y.z, n.x, n.y, n.z]);
  return true;
}

/** Keys of bound hair moved along with the current mesh (null when the binding does not fit the mesh). */
export function boundKeys(ed: EditedHair, b: HairBinding, positions: Float32Array): Float32Array | null {
  if (positions.length / 3 !== b.verts) return null;
  const strands = ed.key_offsets.length - 1;
  if (b.tri.length !== strands * 3) return null;
  const out = ed.co.slice();
  const F0 = new Float64Array(12),
    F1 = new Float64Array(12);
  for (let s = 0; s < strands; s++) {
    const ia = b.tri[s * 3] * 3,
      ib = b.tri[s * 3 + 1] * 3,
      ic = b.tri[s * 3 + 2] * 3;
    if (!frame(b.rest, s * 9, s * 9 + 3, s * 9 + 6, b.bary, s * 3, F0)) continue;
    if (!frame(positions, ia, ib, ic, b.bary, s * 3, F1)) continue;
    for (let k = ed.key_offsets[s]; k < ed.key_offsets[s + 1]; k++) {
      // into the rest frame, out of the current one
      const dx = ed.co[k * 3] - F0[0],
        dy = ed.co[k * 3 + 1] - F0[1],
        dz = ed.co[k * 3 + 2] - F0[2];
      const u = dx * F0[3] + dy * F0[4] + dz * F0[5],
        v = dx * F0[6] + dy * F0[7] + dz * F0[8],
        w = dx * F0[9] + dy * F0[10] + dz * F0[11];
      out[k * 3] = F1[0] + u * F1[3] + v * F1[6] + w * F1[9];
      out[k * 3 + 1] = F1[1] + u * F1[4] + v * F1[7] + w * F1[10];
      out[k * 3 + 2] = F1[2] + u * F1[5] + v * F1[8] + w * F1[11];
    }
  }
  return out;
}
