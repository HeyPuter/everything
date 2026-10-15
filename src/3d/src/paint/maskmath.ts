// Pure helpers of the sculpt mask operators (mix modes, cavity, random values, boundary loops).
import type { PolyFace } from '../mesh/mesh';

export function mixMask(mode: string, cur: number, val: number, fac: number): number {
  let r: number;
  switch (mode) {
    case 'MULTIPLY':
      r = cur * val;
      break;
    case 'DIVIDE':
      r = val > 1e-6 ? cur / val : cur;
      break;
    case 'ADD':
      r = cur + val;
      break;
    case 'SUBTRACT':
      r = cur - val;
      break;
    default:
      r = val;
  }
  r = cur + (r - cur) * fac;
  return r < 0 ? 0 : r > 1 ? 1 : r;
}

/** Concavity per vertex (positive in cavities), relative to the local edge length. */
export function cavityValues(P: Float32Array, N: Float32Array, nbOff: Uint32Array, nb: Uint32Array): Float32Array {
  const nv = P.length / 3;
  const out = new Float32Array(nv);
  for (let v = 0; v < nv; v++) {
    const a = nbOff[v],
      b = nbOff[v + 1];
    if (a === b) continue;
    let x = 0,
      y = 0,
      z = 0,
      len = 0;
    for (let k = a; k < b; k++) {
      const u = nb[k];
      const dx = P[u * 3] - P[v * 3],
        dy = P[u * 3 + 1] - P[v * 3 + 1],
        dz = P[u * 3 + 2] - P[v * 3 + 2];
      x += dx;
      y += dy;
      z += dz;
      len += Math.hypot(dx, dy, dz);
    }
    const n = b - a;
    len /= n;
    // neighbours above the tangent plane → the vertex sits in a dip
    out[v] = len > 0 ? (x * N[v * 3] + y * N[v * 3 + 1] + z * N[v * 3 + 2]) / n / len : 0;
  }
  return out;
}

export function smoothValues(vals: Float32Array, nbOff: Uint32Array, nb: Uint32Array, steps: number) {
  let cur = vals;
  for (let i = 0; i < steps; i++) {
    const next = cur.slice();
    for (let v = 0; v < cur.length; v++) {
      const a = nbOff[v],
        b = nbOff[v + 1];
      if (a === b) continue;
      let s = 0;
      for (let k = a; k < b; k++) s += cur[nb[k]];
      next[v] = (cur[v] + s / (b - a)) / 2;
    }
    cur = next;
  }
  return cur;
}

export function hash01(i: number, seed: number) {
  let x = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(seed + 7, 0x85ebca6b);
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  return ((x >>> 0) % 100003) / 100003;
}

/** Open boundary loops of a polygon soup, oriented to close the surface. */
export function boundaryLoops(polys: PolyFace[]): number[][] {
  const count = new Map<string, number>();
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (const f of polys) for (let i = 0; i < f.verts.length; i++) {
    const k = key(f.verts[i], f.verts[(i + 1) % f.verts.length]);
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const next = new Map<number, number>();
  for (const f of polys)
    for (let i = 0; i < f.verts.length; i++) {
      const a = f.verts[i],
        b = f.verts[(i + 1) % f.verts.length];
      if (count.get(key(a, b)) === 1) next.set(b, a);
    }
  const loops: number[][] = [];
  const used = new Set<number>();
  for (const start of next.keys()) {
    if (used.has(start)) continue;
    const loop: number[] = [];
    let v: number | undefined = start;
    while (v !== undefined && !used.has(v)) {
      used.add(v);
      loop.push(v);
      v = next.get(v);
    }
    if (v === start) loops.push(loop);
  }
  return loops;
}

