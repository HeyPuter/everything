// Lattice selection kernels on the U×V×W point grid.
import type { LatticeData } from '../../data/types';

const idx = (lt: LatticeData, i: number, j: number, k: number) => (k * lt.points_v + j) * lt.points_u + i;
const coords = (lt: LatticeData, p: number): [number, number, number] => {
  const U = lt.points_u,
    V = lt.points_v;
  return [p % U, Math.floor(p / U) % V, Math.floor(p / (U * V))];
};

/** Select the grid-mirrored counterparts of the selected points along one axis (0 = U, 1 = V, 2 = W). */
export function selectMirror(lt: LatticeData, sel: Uint8Array, axis: number, extend: boolean) {
  const n = [lt.points_u, lt.points_v, lt.points_w];
  const src = sel.slice();
  if (!extend) sel.fill(0);
  for (let p = 0; p < src.length; p++) {
    if (!src[p]) continue;
    const c = coords(lt, p);
    c[axis] = n[axis] - 1 - c[axis];
    sel[idx(lt, c[0], c[1], c[2])] = 1;
  }
}

export function selectRandom(sel: Uint8Array, ratio: number, seed: number, on: boolean) {
  let s = (Math.floor(seed) * 7919 + 1) % 2147483647 || 1;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < sel.length; i++) if (rnd() < ratio) sel[i] = on ? 1 : 0;
}

/** Grow (or shrink) the selection by the 6-connected grid neighbourhood. */
export function grow(lt: LatticeData, sel: Uint8Array, more: boolean): Uint8Array {
  const out = sel.slice();
  const n = [lt.points_u, lt.points_v, lt.points_w];
  for (let p = 0; p < sel.length; p++) {
    if (!!sel[p] === more) continue;
    const c = coords(lt, p);
    for (let ax = 0; ax < 3; ax++)
      for (const d of [-1, 1]) {
        const q = [...c];
        q[ax] += d;
        if (q[ax] < 0 || q[ax] >= n[ax]) continue;
        const nb = idx(lt, q[0], q[1], q[2]);
        if (more && sel[nb]) out[p] = 1;
        if (!more && !sel[nb]) out[p] = 0;
      }
  }
  return out;
}
