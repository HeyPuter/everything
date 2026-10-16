// Sphere geometry for drawing points (viewport and render engines). Pure three.js helpers.
import { BufferAttribute, BufferGeometry, InstancedMesh, Matrix4, SphereGeometry } from 'three';
import type { EvalMesh } from '../eval/types';

/** Unit spheres, finer for small point counts. */
const spheres = new Map<string, BufferGeometry>();
export function sphereGeometry(count: number): BufferGeometry {
  const k = count > 200000 ? 'low' : count > 20000 ? 'mid' : 'high';
  let g = spheres.get(k);
  if (!g) {
    g = k === 'low' ? new SphereGeometry(1, 6, 4) : k === 'mid' ? new SphereGeometry(1, 10, 6) : new SphereGeometry(1, 16, 10);
    spheres.set(k, g);
  }
  return g;
}

/** Instance matrices (translation + uniform radius scale) of points. */
export function pointMatrices(positions: Float32Array, radius: ArrayLike<number> | undefined, im: InstancedMesh) {
  const m = new Matrix4();
  const n = positions.length / 3;
  for (let i = 0; i < n; i++) {
    const r = Math.max(1e-6, radius?.[i] ?? 0.01);
    m.makeScale(r, r, r).setPosition(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    im.setMatrixAt(i, m);
  }
  im.instanceMatrix.needsUpdate = true;
  im.computeBoundingSphere();
}

/** Evaluated meshes drawn as spheres: points with radii and nothing else. */
export const isPointMesh = (m: EvalMesh | undefined): m is EvalMesh & { pointRadius: Float32Array } => !!m && !!m.pointRadius && m.indices.length === 0 && !m.curves?.length && m.positions.length > 0;

/** One mesh of spheres around points (for the path tracer). */
export function mergedSpheres(positions: Float32Array, radius: ArrayLike<number>): BufferGeometry {
  const n = positions.length / 3;
  const src = n > 100000 ? new SphereGeometry(1, 6, 4) : new SphereGeometry(1, 10, 6);
  const sp = src.getAttribute('position').array as Float32Array;
  const sn = src.getAttribute('normal').array as Float32Array;
  const su = src.getAttribute('uv').array as Float32Array;
  const si = src.getIndex()!.array;
  const nv = sp.length / 3;
  const pos = new Float32Array(n * nv * 3),
    nor = new Float32Array(n * nv * 3),
    uv = new Float32Array(n * nv * 2);
  const total = n * nv;
  const idx = total > 65535 ? new Uint32Array(n * si.length) : new Uint16Array(n * si.length);
  for (let p = 0; p < n; p++) {
    const r = Math.max(1e-6, radius[p] ?? 0.01);
    const x = positions[p * 3],
      y = positions[p * 3 + 1],
      z = positions[p * 3 + 2];
    const vo = p * nv;
    for (let v = 0; v < nv; v++) {
      pos[(vo + v) * 3] = x + sp[v * 3] * r;
      pos[(vo + v) * 3 + 1] = y + sp[v * 3 + 1] * r;
      pos[(vo + v) * 3 + 2] = z + sp[v * 3 + 2] * r;
    }
    nor.set(sn, vo * 3);
    uv.set(su, vo * 2);
    const io = p * si.length;
    for (let k = 0; k < si.length; k++) idx[io + k] = si[k] + vo;
  }
  src.dispose();
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nor, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setIndex(new BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

