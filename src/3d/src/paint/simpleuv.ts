// Texture Paint ▸ Add Simple UVs: a box (cube) projection packed into a 3×2 atlas, so meshes
// without UVs can be texture painted right away.
import { app, registerOperators } from '../app/app';
import type { MeshData } from '../data/types';
import { activeMeshData, dropSession } from './session';
import { invalidatePaintAttributes } from './display';

/** Box-projected UVs per corner: each face goes to the atlas cell of its dominant axis/side. */
export function simpleUVs(me: Pick<MeshData, 'positions' | 'offsets' | 'indices'>): Float32Array {
  const P = me.positions,
    I = me.indices;
  const nf = me.offsets.length - 1;
  const uvs = new Float32Array(I.length * 2);
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    minX = Math.min(minX, P[i]);
    maxX = Math.max(maxX, P[i]);
    minY = Math.min(minY, P[i + 1]);
    maxY = Math.max(maxY, P[i + 1]);
    minZ = Math.min(minZ, P[i + 2]);
    maxZ = Math.max(maxZ, P[i + 2]);
  }
  const min = [minX, minY, minZ],
    size = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const pad = 0.02;
  for (let f = 0; f < nf; f++) {
    const s = me.offsets[f],
      e = me.offsets[f + 1];
    // face normal (Newell)
    let nx = 0,
      ny = 0,
      nz = 0;
    for (let c = s; c < e; c++) {
      const a = I[c] * 3,
        b = I[c + 1 < e ? c + 1 : s] * 3;
      nx += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
      ny += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
      nz += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
    }
    const ax = Math.abs(nx),
      ay = Math.abs(ny),
      az = Math.abs(nz);
    const axis = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
    const positive = (axis === 0 ? nx : axis === 1 ? ny : nz) >= 0;
    // in-plane axes, flipped on the negative side so the projection is not mirrored
    const [ua, va] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
    const flip = axis === 1 ? positive : !positive;
    const cell = axis * 2 + (positive ? 0 : 1);
    const cx = (cell % 3) / 3,
      cy = Math.floor(cell / 3) / 2;
    for (let c = s; c < e; c++) {
      const v = I[c] * 3;
      let u = (P[v + ua] - min[ua]) / size,
        w = (P[v + va] - min[va]) / size;
      if (flip) u = 1 - u;
      uvs[c * 2] = cx + (pad + u * (1 - 2 * pad)) / 3;
      uvs[c * 2 + 1] = cy + (pad + w * (1 - 2 * pad)) / 2;
    }
  }
  return uvs;
}

registerOperators([
  {
    idname: 'paint.add_simple_uvs',
    label: 'Add Simple UVs',
    description: 'Add a box-projected UV layout so the mesh can be texture painted',
    poll: () => (app.doc.mode === 'TEXTURE_PAINT' || app.doc.mode === 'OBJECT' || app.doc.mode === 'SCULPT') && !!activeMeshData(),
    exec: () => {
      const { me } = activeMeshData()!;
      me.uvs = simpleUVs(me);
      dropSession();
      invalidatePaintAttributes();
      app.changed('geometry');
    },
  },
]);
