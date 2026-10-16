// Viewport wireframe of volume grids: the bounds, boxes around occupied blocks of voxels, or
// points at occupied blocks (Viewport Display ▸ Wireframe).
import type { VolumeDisplay, VolumeGrid } from './types';
import { gridChannels } from './types';
import { gridsBounds, xform } from './grid';

const MAX_BOXES = 12000;

function boxEdges(pos: number[], edges: number[], corners: number[][]) {
  const b = pos.length / 3;
  for (const c of corners) pos.push(c[0], c[1], c[2]);
  const E = [0, 1, 1, 3, 3, 2, 2, 0, 4, 5, 5, 7, 7, 6, 6, 4, 0, 4, 1, 5, 2, 6, 3, 7];
  for (const e of E) edges.push(b + e);
}

/** Wire positions + loose edges (pairs) for a volume's grids. */
export function volumeWire(grids: VolumeGrid[], display: Pick<VolumeDisplay, 'wireframe_type' | 'wireframe_detail'>, clipping = 0): { positions: Float32Array; edges: Uint32Array; points: boolean } {
  const pos: number[] = [];
  const edges: number[] = [];
  const type = display.wireframe_type;
  if (type === 'NONE' || !grids.length) return { positions: new Float32Array(0), edges: new Uint32Array(0), points: false };
  if (type === 'BOUNDS') {
    const b = gridsBounds(grids);
    if (b) {
      const c: number[][] = [];
      for (let i = 0; i < 8; i++) c.push([i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]]);
      boxEdges(pos, edges, c);
    }
    return { positions: Float32Array.from(pos), edges: Uint32Array.from(edges), points: false };
  }
  // blocks of voxels: coarse = 16³, fine = 4³ (grown when there would be too many boxes)
  let block = display.wireframe_detail === 'FINE' ? 4 : 16;
  const p = [0, 0, 0];
  let count = 0;
  for (const g of grids) {
    const ch = gridChannels(g.data_type);
    const [nx, ny, nz] = g.dims;
    let bs = block;
    while (Math.ceil(nx / bs) * Math.ceil(ny / bs) * Math.ceil(nz / bs) > MAX_BOXES) bs *= 2;
    for (let bk = 0; bk < nz; bk += bs)
      for (let bj = 0; bj < ny; bj += bs)
        for (let bi = 0; bi < nx; bi += bs) {
          let on = false;
          for (let k = bk; k < Math.min(nz, bk + bs) && !on; k++)
            for (let j = bj; j < Math.min(ny, bj + bs) && !on; j++) {
              const row = ((k * ny + j) * nx) * ch;
              for (let i = bi; i < Math.min(nx, bi + bs); i++) {
                const v = g.values[row + i * ch];
                if (Math.abs(v - g.background) > clipping || (ch === 3 && (g.values[row + i * ch + 1] || g.values[row + i * ch + 2]))) {
                  on = true;
                  break;
                }
              }
            }
          if (!on) continue;
          if (++count > MAX_BOXES * 2) break;
          const i0 = bi - 0.5, j0 = bj - 0.5, k0 = bk - 0.5;
          const i1 = Math.min(nx, bi + bs) - 0.5, j1 = Math.min(ny, bj + bs) - 0.5, k1 = Math.min(nz, bk + bs) - 0.5;
          if (type === 'POINTS') {
            xform(g.transform, (i0 + i1) / 2, (j0 + j1) / 2, (k0 + k1) / 2, p);
            pos.push(p[0], p[1], p[2]);
            continue;
          }
          const c: number[][] = [];
          for (let q = 0; q < 8; q++) c.push([...xform(g.transform, q & 1 ? i1 : i0, q & 2 ? j1 : j0, q & 4 ? k1 : k0)]);
          boxEdges(pos, edges, c);
        }
  }
  return { positions: Float32Array.from(pos), edges: Uint32Array.from(edges), points: type === 'POINTS' };
}
