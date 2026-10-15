// Spatial queries for sampling nodes: a bounding volume hierarchy over points, edges or
// triangles with nearest-point and ray queries, and mesh triangulation (by face corners).
import { triangulatePoly } from '../../mesh/mesh';
import type { MeshComponent } from '../geometry';

export interface MeshTris {
  /** corner indices, three per triangle */
  tris: Uint32Array;
  triFace: Uint32Array;
}

const triCache = new WeakMap<Uint32Array, { pos: Float32Array; tris: MeshTris }>();

/** Triangles of a mesh's faces (as corner indices). */
export function meshTriangles(m: MeshComponent): MeshTris {
  const c = triCache.get(m.corners);
  if (c && c.pos === m.positions) return c.tris;
  const out: number[] = [];
  const faces: number[] = [];
  const tmp: number[] = [];
  for (let f = 0; f < m.faceCount; f++) {
    const s = m.faceOffsets[f],
      e = m.faceOffsets[f + 1];
    if (e - s < 3) continue;
    tmp.length = 0;
    triangulatePoly(m.positions, m.corners.subarray(s, e), tmp, s);
    for (let k = 0; k < tmp.length; k += 3) {
      out.push(tmp[k], tmp[k + 1], tmp[k + 2]);
      faces.push(f);
    }
  }
  const tris = { tris: Uint32Array.from(out), triFace: Uint32Array.from(faces) };
  triCache.set(m.corners, { pos: m.positions, tris });
  return tris;
}

// ---------------------------------------------------------------------------
// Geometry helpers

/** Closest point on triangle abc to p; returns barycentric weights (wa, wb, wc). */
export function closestOnTriangle(P: ArrayLike<number>, a: number, b: number, c: number, px: number, py: number, pz: number, out: Float64Array): void {
  const ax = P[a * 3],
    ay = P[a * 3 + 1],
    az = P[a * 3 + 2];
  const abx = P[b * 3] - ax,
    aby = P[b * 3 + 1] - ay,
    abz = P[b * 3 + 2] - az;
  const acx = P[c * 3] - ax,
    acy = P[c * 3 + 1] - ay,
    acz = P[c * 3 + 2] - az;
  const apx = px - ax,
    apy = py - ay,
    apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz,
    d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return set(out, 1, 0, 0);
  const bpx = px - P[b * 3],
    bpy = py - P[b * 3 + 1],
    bpz = pz - P[b * 3 + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz,
    d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set(out, 0, 1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return set(out, 1 - v, v, 0);
  }
  const cpx = px - P[c * 3],
    cpy = py - P[c * 3 + 1],
    cpz = pz - P[c * 3 + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz,
    d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set(out, 0, 0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return set(out, 1 - w, 0, w);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return set(out, 0, 1 - w, w);
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den,
    w = vc * den;
  set(out, 1 - v - w, v, w);
}
function set(o: Float64Array, a: number, b: number, c: number) {
  o[0] = a;
  o[1] = b;
  o[2] = c;
}

/** Parameter of the closest point on segment ab to p (0..1). */
export function closestOnSegment(P: ArrayLike<number>, a: number, b: number, px: number, py: number, pz: number): number {
  const ax = P[a * 3],
    ay = P[a * 3 + 1],
    az = P[a * 3 + 2];
  const dx = P[b * 3] - ax,
    dy = P[b * 3 + 1] - ay,
    dz = P[b * 3 + 2] - az;
  const l2 = dx * dx + dy * dy + dz * dz;
  if (l2 === 0) return 0;
  return Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / l2));
}

/** Ray / triangle intersection (both sides); returns t or −1, with barycentrics in `out`. */
export function rayTriangle(P: ArrayLike<number>, a: number, b: number, c: number, o: ArrayLike<number>, d: ArrayLike<number>, out: Float64Array): number {
  const ax = P[a * 3],
    ay = P[a * 3 + 1],
    az = P[a * 3 + 2];
  const e1x = P[b * 3] - ax,
    e1y = P[b * 3 + 1] - ay,
    e1z = P[b * 3 + 2] - az;
  const e2x = P[c * 3] - ax,
    e2y = P[c * 3 + 1] - ay,
    e2z = P[c * 3 + 2] - az;
  const px = d[1] * e2z - d[2] * e2y,
    py = d[2] * e2x - d[0] * e2z,
    pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det;
  const tx = o[0] - ax,
    ty = o[1] - ay,
    tz = o[2] - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -1e-7 || u > 1 + 1e-7) return -1;
  const qx = ty * e1z - tz * e1y,
    qy = tz * e1x - tx * e1z,
    qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < -1e-7 || u + v > 1 + 1e-7) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  if (t < 0) return -1;
  set(out, 1 - u - v, u, v);
  return t;
}

// ---------------------------------------------------------------------------
// BVH

/**
 * Bounding volume hierarchy over primitives given by their bounds. Queries take a callback that
 * measures a primitive (squared distance for nearest, ray parameter for rays).
 */
export class BVH {
  private lo: Float64Array;
  private hi: Float64Array;
  /** node → first child (internal) or −(start+1) (leaf) */
  private child: Int32Array;
  private rightChild: Int32Array;
  private count: Int32Array;
  readonly order: Int32Array;
  private nodes = 0;

  constructor(
    readonly size: number,
    bounds: (i: number, lo: Float64Array, hi: Float64Array) => void,
  ) {
    const plo = new Float64Array(size * 3),
      phi = new Float64Array(size * 3);
    const l = new Float64Array(3),
      h = new Float64Array(3);
    for (let i = 0; i < size; i++) {
      bounds(i, l, h);
      plo.set(l, i * 3);
      phi.set(h, i * 3);
    }
    const cap = Math.max(1, size * 2);
    this.lo = new Float64Array(cap * 3);
    this.hi = new Float64Array(cap * 3);
    this.child = new Int32Array(cap);
    this.rightChild = new Int32Array(cap);
    this.count = new Int32Array(cap);
    this.order = new Int32Array(size);
    for (let i = 0; i < size; i++) this.order[i] = i;
    if (size) this.build(0, size, plo, phi);
  }

  private build(start: number, end: number, plo: Float64Array, phi: Float64Array): number {
    const node = this.nodes++;
    const lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) {
      const p = this.order[i];
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], plo[p * 3 + k]);
        hi[k] = Math.max(hi[k], phi[p * 3 + k]);
      }
    }
    this.lo.set(lo, node * 3);
    this.hi.set(hi, node * 3);
    const n = end - start;
    if (n <= 4) {
      this.child[node] = -(start + 1);
      this.count[node] = n;
      return node;
    }
    const ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const axis = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
    const sub = Array.from(this.order.subarray(start, end));
    sub.sort((a, b) => plo[a * 3 + axis] + phi[a * 3 + axis] - (plo[b * 3 + axis] + phi[b * 3 + axis]));
    this.order.set(sub, start);
    const mid = start + (n >> 1);
    const left = this.build(start, mid, plo, phi);
    const right = this.build(mid, end, plo, phi);
    this.child[node] = left;
    this.rightChild[node] = right;
    return node;
  }

  private boxDist2(n: number, x: number, y: number, z: number): number {
    let d = 0;
    const p = [x, y, z];
    for (let k = 0; k < 3; k++) {
      const lo = this.lo[n * 3 + k],
        hi = this.hi[n * 3 + k];
      const v = p[k] < lo ? lo - p[k] : p[k] > hi ? p[k] - hi : 0;
      d += v * v;
    }
    return d;
  }

  /** Nearest primitive to a point; `measure` returns the squared distance to a primitive. */
  nearest(x: number, y: number, z: number, measure: (prim: number, best: number) => number, maxDist2 = Infinity): { prim: number; dist2: number } {
    let best = maxDist2,
      bestPrim = -1;
    if (!this.size) return { prim: -1, dist2: Infinity };
    const stack = [0];
    while (stack.length) {
      const n = stack.pop()!;
      if (this.boxDist2(n, x, y, z) > best) continue;
      const c = this.child[n];
      if (c < 0) {
        const s = -c - 1;
        for (let i = s; i < s + this.count[n]; i++) {
          const p = this.order[i];
          const d = measure(p, best);
          if (d < best || (d === best && p < bestPrim)) {
            best = d;
            bestPrim = p;
          }
        }
      } else {
        // visit the closer child first
        const a = c,
          b = this.right(n);
        const da = this.boxDist2(a, x, y, z),
          db = this.boxDist2(b, x, y, z);
        if (da < db) stack.push(b, a);
        else stack.push(a, b);
      }
    }
    return { prim: bestPrim, dist2: best };
  }

  private right(n: number): number {
    return this.rightChild[n];
  }

  /** Closest ray hit; `hit` returns the ray parameter of a primitive or −1. */
  raycast(o: ArrayLike<number>, d: ArrayLike<number>, maxT: number, hit: (prim: number) => number): { prim: number; t: number } {
    let best = maxT,
      bestPrim = -1;
    if (!this.size) return { prim: -1, t: Infinity };
    const inv = [1 / d[0], 1 / d[1], 1 / d[2]];
    const stack = [0];
    while (stack.length) {
      const n = stack.pop()!;
      let t0 = 0,
        t1 = best;
      let miss = false;
      for (let k = 0; k < 3 && !miss; k++) {
        let ta = (this.lo[n * 3 + k] - o[k]) * inv[k],
          tb = (this.hi[n * 3 + k] - o[k]) * inv[k];
        if (Number.isNaN(ta) || Number.isNaN(tb)) {
          if (o[k] < this.lo[n * 3 + k] || o[k] > this.hi[n * 3 + k]) miss = true;
          continue;
        }
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
        if (t0 > t1 + 1e-9) miss = true;
      }
      if (miss) continue;
      const c = this.child[n];
      if (c < 0) {
        const s = -c - 1;
        for (let i = s; i < s + this.count[n]; i++) {
          const p = this.order[i];
          const t = hit(p);
          if (t >= 0 && (t < best || (t === best && p < bestPrim))) {
            best = t;
            bestPrim = p;
          }
        }
      } else stack.push(this.right(n), c);
    }
    return { prim: bestPrim, t: best };
  }
}

/** BVH over the triangles of a mesh. */
export function triangleBVH(P: Float32Array, corners: Uint32Array, tris: Uint32Array, subset?: number[]): BVH {
  const ids = subset ?? null;
  const n = ids ? ids.length : tris.length / 3;
  return new BVH(n, (i, lo, hi) => {
    const t = ids ? ids[i] : i;
    lo.fill(Infinity);
    hi.fill(-Infinity);
    for (let k = 0; k < 3; k++) {
      const v = corners[tris[t * 3 + k]];
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], P[v * 3 + a]);
        hi[a] = Math.max(hi[a], P[v * 3 + a]);
      }
    }
  });
}

/** BVH over points. */
export function pointBVH(P: ArrayLike<number>, subset?: number[]): BVH {
  const n = subset ? subset.length : P.length / 3;
  return new BVH(n, (i, lo, hi) => {
    const p = subset ? subset[i] : i;
    for (let a = 0; a < 3; a++) lo[a] = hi[a] = P[p * 3 + a];
  });
}

/** BVH over segments (vertex pairs). */
export function segmentBVH(P: ArrayLike<number>, edges: ArrayLike<number>, subset?: number[]): BVH {
  const n = subset ? subset.length : edges.length / 2;
  return new BVH(n, (i, lo, hi) => {
    const e = subset ? subset[i] : i;
    const a = edges[e * 2],
      b = edges[e * 2 + 1];
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(P[a * 3 + k], P[b * 3 + k]);
      hi[k] = Math.max(P[a * 3 + k], P[b * 3 + k]);
    }
  });
}
